import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDeadLetters, useReplay, useSelectedRun } from '../api/hooks';
import { AttemptTimeline } from '../components/AttemptTimeline';
import {
  EmptyState,
  ErrorState,
  Loading,
  PageTitle,
  Pager,
  Panel,
  StatusBadge,
  btn,
  fmtDateTime,
  shortId,
} from '../components/ui';

const LIMIT = 10;

export function DeadLetters() {
  const { runId } = useSelectedRun();
  const [allRuns, setAllRuns] = useState(false);
  const [offset, setOffset] = useState(0);
  const dead = useDeadLetters({ runId: allRuns ? undefined : runId, limit: LIMIT, offset });
  const replay = useReplay();

  return (
    <>
      <PageTitle
        title="Dead Letters"
        subtitle="Deliveries that spent their retry budget or hit a permanent error. Replay creates a new delivery for the same event and payload; the dead delivery keeps its full history. Dead at the sender does not prove the receiver never processed the event."
        actions={
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={allRuns}
              onChange={(e) => {
                setAllRuns(e.target.checked);
                setOffset(0);
              }}
            />
            All runs
          </label>
        }
      />
      {replay.isError && (
        <div className="mb-3">
          <ErrorState error={replay.error} />
        </div>
      )}
      {replay.isSuccess && (
        <p role="status" className="mb-3 text-sm text-emerald-300" data-testid="replay-created">
          Replay created: delivery {shortId(replay.data.deliveryId)} (replay of{' '}
          {shortId(replay.data.replayOfDeliveryId)}).
        </p>
      )}

      {dead.isError ? (
        <ErrorState error={dead.error} retry={() => void dead.refetch()} />
      ) : !dead.data ? (
        <Loading />
      ) : dead.data.items.length === 0 ? (
        <EmptyState
          title="No dead letters"
          hint="Run “Exhaust retries and replay” or “Invalid signature” to produce some."
        />
      ) : (
        <>
          <div className="space-y-4" data-testid="dead-letters">
            {dead.data.items.map((d) => (
              <Panel
                key={d.id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      className="font-mono text-sky-300 hover:underline"
                      to={`/events/${d.eventId}`}
                    >
                      event {shortId(d.eventId)}
                    </Link>
                    <span className="text-xs font-normal text-muted">{d.eventType}</span>
                    <StatusBadge value="dead" />
                  </span>
                }
                action={
                  <button
                    className={btn}
                    disabled={replay.isPending || d.activeReplays > 0}
                    onClick={() => replay.mutate(d.id)}
                    data-testid={`replay-${shortId(d.id)}`}
                  >
                    {d.activeReplays > 0 ? 'Replay in progress' : 'Replay'}
                  </button>
                }
              >
                <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-5">
                  <div>
                    <dt className="text-xs text-muted">Delivery</dt>
                    <dd className="font-mono">{shortId(d.id)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Reason</dt>
                    <dd className="font-mono text-rose-300">{d.terminalReason ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Last error</dt>
                    <dd className="font-mono text-amber-300">{d.lastErrorCode ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Attempts</dt>
                    <dd className="font-mono">
                      {d.attemptCount}/{d.maxAttempts}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Replays so far</dt>
                    <dd className="font-mono">{d.replayCount}</dd>
                  </div>
                </dl>
                <details>
                  <summary className="cursor-pointer text-sm text-sky-300">
                    Attempt history ({d.attempts.length}) · died {fmtDateTime(d.finishedAt)}
                  </summary>
                  <div className="mt-3">
                    <AttemptTimeline attempts={d.attempts} />
                  </div>
                </details>
              </Panel>
            ))}
          </div>
          <Pager total={dead.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
        </>
      )}
    </>
  );
}
