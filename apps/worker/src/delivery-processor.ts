import { Inject, Injectable } from '@nestjs/common';
import {
  claimDelivery,
  completeAttempt,
  loadSendContext,
  policyFromConfig,
  type Db,
} from '@lab/db';
import {
  HEADERS,
  LIMITS,
  decideAfterAttempt,
  decideFault,
  errorFields,
  isUrlAllowed,
  jitterUnitFor,
  parseAllowlist,
  signPayload,
  type AllowedTarget,
  type AppConfig,
  type Logger,
  type SendResult,
} from '@lab/shared';
import { sendWebhook, type SendObservation } from './sender';
import { APP_CONFIG, DB, LOGGER } from './tokens';

export interface DeliveryJob {
  deliveryId: string;
  generation: number;
  outboxId?: string;
}

export type ProcessOutcome =
  { status: 'skipped'; reason: string } | { status: 'completed'; applied: boolean; kind: string };

@Injectable()
export class DeliveryProcessor {
  private readonly allowlist: AllowedTarget[];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly log: Logger,
  ) {
    this.allowlist = parseAllowlist(config.ALLOWED_RECEIVER_URLS);
  }

  /** Secrets come from the controlled server environment, referenced by name from the endpoint. */
  private resolveSecret(ref: string): string | undefined {
    const known: Record<string, string | undefined> = {
      RECEIVER_SECRET: this.config.RECEIVER_SECRET,
    };
    return known[ref];
  }

  async process(job: DeliveryJob): Promise<ProcessOutcome> {
    // 1) Atomic claim: generation + state + due + budget are all checked by one UPDATE. A job that
    //    is replayed after the delivery finished (or superseded) stops here - no HTTP, no effect.
    const claim = await claimDelivery(this.db, {
      deliveryId: job.deliveryId,
      generation: job.generation,
      leaseMs: this.config.LEASE_MS,
    });
    if (!claim.claimed) {
      this.log.info('job skipped', {
        deliveryId: job.deliveryId,
        generation: job.generation,
        reason: claim.reason,
      });
      return { status: 'skipped', reason: claim.reason };
    }
    const c = claim.claim;
    const ctx = await loadSendContext(this.db, c);
    const base = {
      runId: ctx.run.id,
      eventId: c.eventId,
      deliveryId: c.deliveryId,
      attemptId: c.attemptId,
      correlationId: ctx.correlationId,
      attemptNo: c.attemptNo,
    };
    const log = this.log.child(base);

    const policy = policyFromConfig(ctx.run.config, c.maxAttempts);
    policy.httpTimeoutMs = Math.min(
      policy.httpTimeoutMs,
      LIMITS.httpTimeoutHardCapMs,
      this.config.HTTP_TIMEOUT_HARD_CAP_MS,
    );
    const faultCtx = {
      eventIndex: ctx.logicalIndex,
      deliveryOrdinal: c.ordinal,
      attemptNo: c.attemptNo,
    };
    const fault = decideFault(ctx.run.faultPlan, ctx.run.phase, faultCtx);

    // 2) Send (no database transaction is open while the request is in flight).
    let observation: SendObservation;
    const secret = this.resolveSecret(ctx.endpoint.secretRef);
    if (!ctx.endpoint.enabled) {
      observation = this.localError('endpoint_disabled');
    } else if (!isUrlAllowed(ctx.endpoint.url, this.allowlist)) {
      observation = this.localError('endpoint_not_allowlisted');
    } else if (!secret) {
      observation = this.localError('secret_unavailable');
    } else {
      const timestamp = Math.floor(Date.now() / 1000);
      // Fresh timestamp + signature per attempt; payload bytes are the stored raw string.
      const signature = signPayload(
        fault.kind === 'sign_invalid' ? `${secret}-tampered` : secret,
        timestamp,
        ctx.rawPayload,
      );
      observation = await sendWebhook({
        url: ctx.endpoint.url,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'webhook-chaos-lab/0.1',
          [HEADERS.eventId]: c.eventId,
          [HEADERS.deliveryId]: c.deliveryId,
          [HEADERS.attemptNo]: String(c.attemptNo),
          [HEADERS.timestamp]: String(timestamp),
          [HEADERS.signature]: signature,
          ...(ctx.correlationId ? { [HEADERS.correlationId]: ctx.correlationId } : {}),
        },
        body: ctx.rawPayload,
        timeoutMs: policy.httpTimeoutMs,
        maxPreviewBytes: LIMITS.maxResponsePreviewBytes,
      });
    }

    // 3) Decide (pure) and persist atomically, fenced by the claim token.
    const decision = decideAfterAttempt({
      attemptNo: c.attemptNo,
      policy,
      nowMs: Date.now(),
      result: observation.result,
      jitterUnit: jitterUnitFor(ctx.run.seed, faultCtx),
    });
    try {
      const { applied } = await completeAttempt(this.db, {
        deliveryId: c.deliveryId,
        attemptNo: c.attemptNo,
        claimToken: c.claimToken,
        decision,
        observation: {
          httpStatus: observation.httpStatus,
          errorCode: decision.kind === 'succeeded' ? null : decision.errorCode,
          durationMs: observation.durationMs,
          responsePreview: observation.responsePreview,
        },
      });
      log.info('attempt finished', {
        decision: decision.kind,
        httpStatus: observation.httpStatus,
        outcome: decision.outcome,
        durationMs: observation.durationMs,
        applied,
        ...(decision.kind === 'retry' ? { delayMs: decision.delayMs } : {}),
        ...(decision.kind === 'dead' ? { reason: decision.reason } : {}),
      });
      return { status: 'completed', applied, kind: decision.kind };
    } catch (err) {
      // The attempt stays in_progress; once the lease expires the recovery scheduler marks it
      // worker_lost and reschedules, so a transient DB failure here cannot strand the delivery.
      log.error('could not persist attempt result', errorFields(err));
      throw err;
    }
  }

  private localError(code: string): SendObservation {
    const result: SendResult = { kind: 'local_error', code };
    return { result, httpStatus: null, responsePreview: null, durationMs: 0 };
  }
}
