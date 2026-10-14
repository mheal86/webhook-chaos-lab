export const HEADERS = {
  eventId: 'x-lab-event-id',
  deliveryId: 'x-lab-delivery-id',
  attemptNo: 'x-lab-attempt-no',
  timestamp: 'x-lab-timestamp',
  signature: 'x-lab-signature',
  correlationId: 'x-lab-correlation-id',
} as const;

export const EVENT_TYPES = {
  counterIncrement: 'demo.counter.increment',
  orderSnapshot: 'demo.order.snapshot',
} as const;
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
export const EVENT_TYPE_LIST: EventType[] = [EVENT_TYPES.counterIncrement, EVENT_TYPES.orderSnapshot];

export const LIMITS = {
  maxPayloadBytes: 64 * 1024,
  maxResponsePreviewBytes: 8 * 1024,
  maxEventsPerRun: 100,
  maxDuplicatesPerEvent: 20,
  signatureToleranceSeconds: 300,
  maxAttemptsCeiling: 10,
  httpTimeoutHardCapMs: 10_000,
} as const;

export const DELIVERY_STATES = ['queued', 'in_flight', 'retry_wait', 'succeeded', 'dead'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export const TERMINAL_DELIVERY_STATES: DeliveryState[] = ['succeeded', 'dead'];

export const ATTEMPT_OUTCOMES = [
  'in_progress',
  'success',
  'http_retryable',
  'http_permanent',
  'network_error',
  'timeout',
  'worker_lost',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
/** Outcomes where the sender cannot know whether the receiver processed the request. */
export const UNKNOWN_AT_SENDER_OUTCOMES: AttemptOutcome[] = ['timeout', 'worker_lost', 'network_error'];

export const RUN_STATUSES = ['open', 'running', 'passed', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RECEIVER_RESULTS = [
  'received',
  'processed',
  'duplicate',
  'stale',
  'conflict',
  'rejected_signature',
  'rejected_bad_request',
  'injected_failure',
  'error',
] as const;
export type ReceiverResult = (typeof RECEIVER_RESULTS)[number];

/** Well-known ids of the seeded local workspace. */
export const SEED = {
  consumerId: 'receiver-fixture',
  endpointId: '00000000-0000-4000-8000-000000000001',
  manualRunId: '00000000-0000-4000-8000-0000000000aa',
} as const;
