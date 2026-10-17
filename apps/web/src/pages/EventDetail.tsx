import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useEvent, useReplay } from '../api/hooks';
import { AttemptTimeline } from '../components/AttemptTimeline';
import {
  Code,
  ErrorState,
  Json,
  Loading,
  PageTitle,
  Panel,
  StatusBadge,
  btn,
  fmtDateTime,
  shortId,
} from '../components/ui';

export function EventDetailPage() {
  const { id } = useParams();
  const event = useEvent(id);
  const replay = useReplay();

  if (event.isError) {
    return event.error instanceof ApiError && event.error.status === 404 ? (
      <ErrorState error={new Error('Event not found')} />
    ) : (
      <ErrorState error={event.error} retry={() => void event.refetch()} />
    );
  }
  if (!event.data) return <Loading />;
  const e = event.data;

  return (
    <>
      <PageTitle
        title={`Event ${shortId(e.id)}`}
        subtitle={
          <>
            {e.type} · aggregate <Code>{e.aggregateId}</Code> · sequence {e.sequence} · created{' '}
            {fmtDateTime(e.createdAt)}
          </>
        }
        actions={
          <Link className="text-sm text-sky-300 hover:underline" to="/events">
            ← All events
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Payload (raw, signed bytes)" className="lg:col-span-1">
          <Json value={e.rawPayload} />
          <dl className="mt-3 space-y-1 text-xs text-muted">
            <div>
              <dt className="inline">Event id: </dt>
              <dd className="inline font-mono text-slate-300">{e.id}</dd>
            </div>
            <div>
              <dt className="inline">SHA-256: </dt>
              <dd className="inline break-all font-mono text-slate-300">{e.payloadHash}</dd>
            </div>
            <div>
              <dt className="inline">Run: </dt>
              <dd className="inline font-mono text-slate-300">{shortId(e.runId)}</dd>
            </div>
            {e.correlationId && (
              <div>
                <dt className="inline">Correlation: </dt>
                <dd className="inline font-mono text-slate-300">{e.correlationId}</dd>
              </div>
            )}
          </dl>
          <p className="mt-3 text-xs text-muted">
            Retries and replays resend exactly these bytes; only the timestamp and signature are
            fresh per attempt.
          </p>
        </Panel>

        <div className="space-y-5 lg:col-span-2">
          {e.deliveries.map((d) => {
            const terminal = d.state === 'succeeded' || d.state === 'dead';
            return (
              <Panel
                key={d.id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    Delivery <span className="font-mono">{shortId(d.id)}</span>
                    <span className="text-xs font-normal text-muted">#{d.ordinal}</span>
                    <StatusBadge value={d.state} />
                  </span>
                }
                action={
                  terminal && (
                    <button
                      className={btn}
                      disabled={replay.isPending}
                      onClick={() => replay.mutate(d.id)}
                      data-testid={`replay-${shortId(d.id)}`}
                    >
                      Replay
                    </button>
                  )
                }
              >
                <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted">Attempts</dt>
                    <dd className="font-mono">
                      {d.attemptCount}/{d.maxAttempts}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Generation</dt>
                    <dd className="font-mono">{d.generation}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Next attempt</dt>
                    <dd>{d.nextAttemptAt ? fmtDateTime(d.nextAttemptAt) : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Finished</dt>
                    <dd>{fmtDateTime(d.finishedAt)}</dd>
                  </div>
                  {d.terminalReason && (
                    <div>
                      <dt className="text-xs text-muted">Terminal reason</dt>
                      <dd className="font-mono text-rose-300">{d.terminalReason}</dd>
                    </div>
                  )}
                  {d.lastErrorCode && (
                    <div>
                      <dt className="text-xs text-muted">Last error</dt>
                      <dd className="font-mono text-amber-300">{d.lastErrorCode}</dd>
                    </div>
                  )}
                  {d.replayOfDeliveryId && (
                    <div className="col-span-2">
                      <dt className="text-xs text-muted">Replay of</dt>
                      <dd className="font-mono">
                        {shortId(d.replayOfDeliveryId)}{' '}
                        <span className="text-muted">(original keeps its history)</span>
                      </dd>
                    </div>
                  )}
                </dl>
                <AttemptTimeline attempts={d.attempts} />
              </Panel>
            );
          })}
          {replay.isError && <ErrorState error={replay.error} />}
          {replay.isSuccess && (
            <p role="status" className="text-sm text-emerald-300">
              Replay created: new delivery {shortId(replay.data.deliveryId)} for the same event.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
