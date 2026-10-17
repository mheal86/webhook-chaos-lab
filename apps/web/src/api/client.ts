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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
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
  runs: () => request<RunListItem[]>('/runs'),
  run: (id: string) => request<RunDto>(`/runs/${id}`),
  metrics: (id: string) => request<RunMetrics>(`/runs/${id}/metrics`),
  scenarios: () =>
    request<{ defaultConfig: RunConfig; scenarios: ScenarioCatalogEntry[] }>('/scenarios'),
  createRun: (type: string, body: { seed?: number; config?: Record<string, number> }) =>
    request<{ runId: string; seed: number }>(`/scenarios/${type}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  events: (q: EventsQuery) => request<Paginated<EventSummary>>(`/events${qs({ ...q })}`),
  event: (id: string) => request<EventDetail>(`/events/${id}`),
  deadLetters: (q: { runId?: string; limit?: number; offset?: number }) =>
    request<Paginated<DeadLetterItem>>(`/dead-letters${qs(q)}`),
  replay: (deliveryId: string) =>
    request<{ deliveryId: string; replayOfDeliveryId: string; eventId: string }>(
      `/deliveries/${deliveryId}/replay`,
      {
        method: 'POST',
      },
    ),
  receiverState: (runId: string) => request<ReceiverStateDto>(`/receiver/state?runId=${runId}`),
};
