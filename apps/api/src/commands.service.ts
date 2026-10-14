import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ZodError } from 'zod';
import {
  DomainError,
  TX_OPTIONS,
  createRun,
  insertEventWithDeliveries,
  isUniqueViolation,
  policyFromConfig,
  replayDelivery,
  type Db,
} from '@lab/db';
import {
  SCENARIO_TYPES,
  SEED,
  buildBlueprint,
  type RunConfig,
  type ScenarioType,
} from '@lab/shared';
import type { CreateEventDto, CreateRunDto } from './dto';
import { DB } from './tokens';

@Injectable()
export class CommandsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Accepts an event: ONE PostgreSQL transaction creates the event, its deliveries and the outbox
   * rows. Only after it commits does the controller answer 202; Redis is not involved here.
   */
  async createEvent(dto: CreateEventDto, correlationId: string | null) {
    const runId = dto.runId ?? SEED.manualRunId;
    try {
      return await this.db.$transaction(async (tx) => {
        const runs = await tx.$queryRaw<Array<{ status: string; config: RunConfig }>>`
          SELECT status::text AS status, config FROM scenario_runs WHERE id = ${runId} FOR UPDATE`;
        const run = runs[0];
        if (!run) throw new DomainError('not_found', `run ${runId} not found`);
        if (run.status !== 'open') {
          throw new DomainError('conflict', `run ${runId} is ${run.status}; manual events need an open run`);
        }
        const endpoints = dto.endpointId
          ? await tx.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM endpoints WHERE id = ${dto.endpointId} AND enabled = true`
          : await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM endpoints WHERE enabled = true ORDER BY consumer_id`;
        if (endpoints.length === 0) throw new DomainError('invalid', 'no enabled endpoint matches');
        const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM events WHERE run_id = ${runId}`;
        return insertEventWithDeliveries(tx, {
          runId,
          eventId: dto.eventId,
          type: dto.type,
          aggregateId: dto.aggregateId,
          sequence: dto.sequence,
          data: dto.data,
          logicalIndex: n,
          correlationId,
          endpointIds: endpoints.map((e) => e.id),
          copies: 1,
          maxAttempts: policyFromConfig(run.config).maxAttempts,
        });
      }, TX_OPTIONS).then((r) => ({ ...r, runId }));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DomainError('conflict', 'an event with this id already exists');
      }
      throw err;
    }
  }

  async createRun(type: string, dto: CreateRunDto) {
    if (!(SCENARIO_TYPES as readonly string[]).includes(type)) {
      throw new DomainError('not_found', `unknown scenario ${type}`);
    }
    const seed = dto.seed ?? randomInt(0, 2_147_483_647);
    let blueprint;
    try {
      blueprint = buildBlueprint(type as ScenarioType, seed, dto.config as never);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new DomainError(
          'invalid',
          'invalid scenario config',
          err.issues.map((i: { path: PropertyKey[]; message: string }) => ({ path: i.path.map(String).join('.'), message: i.message })),
        );
      }
      throw err;
    }
    const { runId } = await createRun(this.db, { blueprint });
    return { runId, seed };
  }

  replay(deliveryId: string) {
    return replayDelivery(this.db, deliveryId);
  }
}
