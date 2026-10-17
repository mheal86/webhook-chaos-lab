import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type EventsQuery } from './client';

/** Poll every ~2 s while a run is active, back off while idle. */
export const ACTIVE_POLL_MS = 2000;
export const IDLE_POLL_MS = 10_000;

export function useRuns() {
  return useQuery({
    queryKey: ['runs'],
    queryFn: api.runs,
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === 'running') ? ACTIVE_POLL_MS : IDLE_POLL_MS,
  });
}

// ---- selected run (shared by every screen) -------------------------------------------------

interface RunSelection {
  runId: string | undefined;
  setRunId: (id: string) => void;
  isActive: boolean;
}
const RunContext = createContext<RunSelection>({
  runId: undefined,
  setRunId: () => undefined,
  isActive: false,
});

const STORAGE_KEY = 'chaos-lab.runId';
function readStored(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function RunProvider({ children }: { children: ReactNode }) {
  const runs = useRuns();
  const [chosen, setChosen] = useState<string | undefined>(readStored);
  const list = runs.data;
  const exists = chosen !== undefined && list?.some((r) => r.id === chosen);
  // Default to the newest scenario run (not the manual workspace) once runs are known.
  const fallback = list?.find((r) => r.type !== 'manual')?.id ?? list?.[0]?.id;
  const runId = exists ? chosen : list ? fallback : chosen;

  const value = useMemo<RunSelection>(
    () => ({
      runId,
      setRunId: (id) => {
        setChosen(id);
        try {
          localStorage.setItem(STORAGE_KEY, id);
        } catch {
          /* storage unavailable: selection just is not remembered */
        }
      },
      isActive: Boolean(list?.some((r) => r.status === 'running')),
    }),
    [runId, list],
  );
  useEffect(() => undefined, []);
  return createElement(RunContext.Provider, { value }, children);
}

export const useSelectedRun = () => useContext(RunContext);

const pollMs = (active: boolean) => (active ? ACTIVE_POLL_MS : IDLE_POLL_MS);

export function useRun(id: string | undefined) {
  const { isActive } = useSelectedRun();
  return useQuery({
    queryKey: ['run', id],
    queryFn: () => api.run(id!),
    enabled: Boolean(id),
    refetchInterval: (q) => pollMs(isActive || q.state.data?.status === 'running'),
  });
}

export function useMetrics(id: string | undefined) {
  const { isActive } = useSelectedRun();
  return useQuery({
    queryKey: ['metrics', id],
    queryFn: () => api.metrics(id!),
    enabled: Boolean(id),
    refetchInterval: pollMs(isActive),
  });
}

export function useScenarios() {
  return useQuery({ queryKey: ['scenarios'], queryFn: api.scenarios, staleTime: Infinity });
}

export function useEvents(q: EventsQuery) {
  const { isActive } = useSelectedRun();
  return useQuery({
    queryKey: ['events', q],
    queryFn: () => api.events(q),
    placeholderData: keepPreviousData,
    refetchInterval: pollMs(isActive),
  });
}

export function useEvent(id: string | undefined) {
  const { isActive } = useSelectedRun();
  return useQuery({
    queryKey: ['event', id],
    queryFn: () => api.event(id!),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const open = q.state.data?.deliveries.some(
        (d) => d.state !== 'succeeded' && d.state !== 'dead',
      );
      return pollMs(isActive || Boolean(open));
    },
  });
}

export function useDeadLetters(q: { runId?: string; limit?: number; offset?: number }) {
  const { isActive } = useSelectedRun();
  return useQuery({
    queryKey: ['dead-letters', q],
    queryFn: () => api.deadLetters(q),
    placeholderData: keepPreviousData,
    refetchInterval: pollMs(isActive),
  });
}

export function useReceiverState(runId: string | undefined) {
  const { isActive } = useSelectedRun();
  return useQuery({
    queryKey: ['receiver', runId],
    queryFn: () => api.receiverState(runId!),
    enabled: Boolean(runId),
    refetchInterval: pollMs(isActive),
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  const { setRunId } = useSelectedRun();
  return useMutation({
    mutationFn: ({
      type,
      seed,
      config,
    }: {
      type: string;
      seed?: number;
      config?: Record<string, number>;
    }) => api.createRun(type, { seed, config }),
    onSuccess: async ({ runId }) => {
      setRunId(runId);
      await qc.invalidateQueries();
    },
  });
}

export function useReplay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) => api.replay(deliveryId),
    onSuccess: () => qc.invalidateQueries(),
  });
}
