import type {
  AttemptOutcome,
  DeliveryState,
  EventType,
  ReceiverResult,
  RunStatus,
} from './constants';
import type { FaultPlan } from './faults';
import type { AssertionSpec, RunConfig, RunType, ScenarioStep } from './scenarios';

export type AssertionStatus = 'pending' | 'passed' | 'failed';

export interface AssertionResult extends AssertionSpec {
  actual: number | string | null;
  expectedValue: number | string | null;
  status: AssertionStatus;
}

export interface LatencyStat {
  /** Nearest-rank p95 (percentile_disc 0.95) of attempt duration. */
  p95: number | null;
  sampleCount: number;
  unit: 'ms';
  /** Which attempts are in the sample and over which window. */
  window: string;
}

export interface RunMetrics {
  runId: string;
  events: number;
  deliveries: {
    total: number;
    queued: number;
    in_flight: number;
    retry_wait: number;
    succeeded: number;
    dead: number;
    nonTerminal: number;
    deadByReason: Record<string, number>;
  };
  attempts: {
    total: number;
    byOutcome: Record<AttemptOutcome, number>;
    maxPerDelivery: number;
    latency: LatencyStat;
  };
  receiver: {
    requests: number;
    byResult: Record<ReceiverResult, number>;
    /** Event sequences in the order the receiver accepted requests (signature verified). */
    receiveOrder: string;
  };
  businessEffects: number;
  projections: { counterValue: number | null; orderSequence: number | null };
  lineage: { replayDeliveries: number; deadWithReplay: number };
  generatedAt: string;
}

export interface RunDto {
  id: string;
  type: RunType;
  status: RunStatus;
  seed: number;
  phase: number;
  config: RunConfig | null;
  faultPlan: FaultPlan | null;
  steps: ScenarioStep[] | null;
  stepIndex: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
  assertions: AssertionResult[];
}

export interface RunListItem {
  id: string;
  type: RunType;
  status: RunStatus;
  seed: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface EndpointDto {
  id: string;
  consumerId: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface EventSummary {
  id: string;
  runId: string;
  type: EventType;
  aggregateId: string;
  sequence: number;
  logicalIndex: number;
  occurredAt: string;
  createdAt: string;
  payloadHash: string;
  deliveryCount: number;
  deliveryStates: Partial<Record<DeliveryState, number>>;
}

export interface DeliveryDto {
  id: string;
  eventId: string;
  runId: string;
  endpointId: string;
  consumerId: string | null;
  replayOfDeliveryId: string | null;
  ordinal: number;
  state: DeliveryState;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  leaseUntil: string | null;
  generation: number;
  terminalReason: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AttemptDto {
  id: string;
  deliveryId: string;
  attemptNo: number;
  generation: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: AttemptOutcome;
  /** True when the sender cannot know whether the receiver processed the request. */
  unknownAtSender: boolean;
  httpStatus: number | null;
  errorCode: string | null;
  durationMs: number | null;
  responsePreview: string | null;
  retryAfterApplied: boolean;
  scheduledRetryAt: string | null;
  lateResult: { receivedAt: string; httpStatus: number | null; errorCode: string | null } | null;
}

export interface EventDetail extends EventSummary {
  rawPayload: string;
  correlationId: string | null;
  deliveries: Array<DeliveryDto & { attempts: AttemptDto[] }>;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ReceiverRequestDto {
  id: string;
  seq: number;
  runId: string | null;
  consumerId: string;
  eventId: string | null;
  deliveryId: string | null;
  attemptNo: number | null;
  receivedAt: string;
  completedAt: string | null;
  result: ReceiverResult;
  httpStatus: number | null;
  detail: string | null;
  signatureValid: boolean | null;
  eventSequence: number | null;
}

export interface BusinessEffectDto {
  id: string;
  eventId: string;
  kind: string;
  data: unknown;
  createdAt: string;
}

export interface ReceiverStateDto {
  runId: string;
  requests: ReceiverRequestDto[];
  counter: { aggregateId: string; value: number; updatedAt: string } | null;
  order: { aggregateId: string; sequence: number; state: unknown; updatedAt: string } | null;
  effects: BusinessEffectDto[];
  summary: RunMetrics['receiver'] & { businessEffects: number };
}

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}
