import type {
  AttemptDto,
  DeliveryDto,
  EventDetail,
  EventSummary,
  Paginated,
  ReceiverStateDto,
  RunDto,
  RunListItem,
  RunMetrics,
  ScenarioCatalogEntry,
  RunConfig,
} from '@lab/shared/web';
import { demoApi } from './demoSimulator';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let useSimulatorMode: boolean | null = null;

async function withFallback<T>(realCall: () => Promise<T>, demoCall: () => Promise<T>): Promise<T> {
  if (useSimulatorMode === true) {
    return demoCall();
  }
  try {
    const res = await realCall();
    useSimulatorMode = false;
    return res;
  } catch {
    useSimulatorMode = true;
    return demoCall();
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error('Non-JSON response (static hosting mode)');
  }
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const msg = Array.isArray(body.message)
      ? body.message.join('; ')
      : String(body.message ?? res.statusText);
    throw new ApiError(res.status, String(body.error ?? res.status), msg, body.details);
  }
  return body as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export interface DeadLetterItem extends DeliveryDto {
  eventType: string;
  aggregateId: string;
  replayCount: number;
  activeReplays: number;
  attempts: AttemptDto[];
}

export interface EventsQuery {
  runId?: string;
  type?: string;
  q?: string;
  state?: string;
  limit?: number;
  offset?: number;
}

export const api = {
  runs: () =>
    withFallback(
      () => request<RunListItem[]>('/runs'),
      () => demoApi.runs(),
    ),
  run: (id: string) =>
    withFallback(
      () => request<RunDto>(`/runs/${id}`),
      () => demoApi.run(id),
    ),
  metrics: (id: string) =>
    withFallback(
      () => request<RunMetrics>(`/runs/${id}/metrics`),
      () => demoApi.metrics(id),
    ),
  scenarios: () =>
    withFallback(
      () => request<{ defaultConfig: RunConfig; scenarios: ScenarioCatalogEntry[] }>('/scenarios'),
      () => demoApi.scenarios(),
    ),
  createRun: (type: string, body: { seed?: number; config?: Record<string, number> }) =>
    withFallback(
      () =>
        request<{ runId: string; seed: number }>(`/scenarios/${type}/runs`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      () => demoApi.createRun(type, body),
    ),
  events: (q: EventsQuery) =>
    withFallback(
      () => request<Paginated<EventSummary>>(`/events${qs({ ...q })}`),
      () => demoApi.events(q),
    ),
  event: (id: string) =>
    withFallback(
      () => request<EventDetail>(`/events/${id}`),
      () => demoApi.event(id),
    ),
  deadLetters: (q: { runId?: string; limit?: number; offset?: number }) =>
    withFallback(
      () => request<Paginated<DeadLetterItem>>(`/dead-letters${qs(q)}`),
      () => demoApi.deadLetters(q),
    ),
  replay: (deliveryId: string) =>
    withFallback(
      () =>
        request<{ deliveryId: string; replayOfDeliveryId: string; eventId: string }>(
          `/deliveries/${deliveryId}/replay`,
          {
            method: 'POST',
          },
        ),
      () => demoApi.replay(deliveryId),
    ),
  receiverState: (runId: string) =>
    withFallback(
      () => request<ReceiverStateDto>(`/receiver/state?runId=${runId}`),
      () => demoApi.receiverState(runId),
    ),
};
