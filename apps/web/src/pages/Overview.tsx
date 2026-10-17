import { Link } from 'react-router-dom';
import { useMetrics, useRun, useSelectedRun } from '../api/hooks';
import { AssertionsTable } from '../components/Assertions';
import {
  EmptyState,
  ErrorState,
  Loading,
  PageTitle,
  Panel,
  Stat,
  StatusBadge,
  fmtDateTime,
  shortId,
} from '../components/ui';

export function Overview() {
  const { runId } = useSelectedRun();
  const run = useRun(runId);
  const metrics = useMetrics(runId);

  if (!runId) {
    return (
      <>
        <PageTitle title="Overview" />
        <EmptyState
          title="No run yet"
          hint={
            <>
              Pick a fault scenario in the{' '}
              <Link className="text-sky-300 underline" to="/runner">
                Scenario Runner
              </Link>{' '}
              and press Run.
            </>
          }
        />
      </>
    );
  }
  if (metrics.isError)
    return <ErrorState error={metrics.error} retry={() => void metrics.refetch()} />;
  if (!metrics.data) return <Loading />;

  const m = metrics.data;
  const retrying = m.deliveries.queued + m.deliveries.in_flight + m.deliveries.retry_wait;
  const lat = m.attempts.latency;

  return (
    <>
      <PageTitle
        title="Overview"
        subtitle={
          <>
            Numbers for the selected run, straight from PostgreSQL. A <b>delivery</b> succeeds when
            it ends in a 2xx attempt; an <b>HTTP attempt</b> is a single request; a{' '}
            <b>business effect</b> is what the receiver actually applied. These are three different
            counts.
          </>
        }
        actions={
          run.data && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <StatusBadge value={run.data.status} />
              <span>
                {run.data.type} · seed {run.data.seed} · {shortId(run.data.id)}
              </span>
            </div>
          )
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="overview-stats">
        <Stat label="Events" value={m.events} />
        <Stat label="Deliveries" value={m.deliveries.total} hint="one event can have several" />
        <Stat
          label="Succeeded"
          value={m.deliveries.succeeded}
          tone="green"
          hint="deliveries ending in 2xx"
        />
        <Stat
          label="Dead"
          value={m.deliveries.dead}
          tone={m.deliveries.dead ? 'red' : undefined}
          hint="retry budget spent / permanent error"
        />
        <Stat
          label="Retrying"
          value={retrying}
          tone={retrying ? 'amber' : undefined}
          hint="queued + in flight + retry wait"
        />
        <Stat
          label="HTTP attempts"
          value={m.attempts.total}
          hint={`${m.attempts.byOutcome.success} succeeded · ${m.attempts.byOutcome.timeout} timeout`}
        />
        <Stat
          label="Business effects"
          value={m.businessEffects}
          tone="blue"
          hint="applied once by the receiver"
        />
        <Stat
          label="Receiver duplicates"
          value={m.receiver.byResult.duplicate}
          hint={`${m.receiver.byResult.stale} stale · ${m.receiver.byResult.conflict} conflict`}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Panel
          title="Expected vs actual"
          className="lg:col-span-2"
          action={
            <Link to="/runner" className="text-sm text-sky-300 hover:underline">
              Scenario Runner →
            </Link>
          }
        >
          {run.data && run.data.assertions.length > 0 ? (
            <AssertionsTable assertions={run.data.assertions} />
          ) : (
            <p className="text-sm text-muted">
              This run has no scenario expectations (manual workspace).
            </p>
          )}
          {run.data?.failureReason && (
            <p className="mt-3 text-sm text-rose-300">Failure reason: {run.data.failureReason}</p>
          )}
        </Panel>

        <div className="space-y-5">
          <Panel title="Attempt latency (p95)">
            <div className="text-2xl font-semibold tabular-nums">
              {lat.p95 === null ? '—' : `${lat.p95} ${lat.unit}`}
            </div>
            <p className="mt-2 text-xs text-muted">
              Nearest-rank p95 over <b>{lat.sampleCount}</b> samples. Sample: {lat.window}.
            </p>
          </Panel>
          <Panel title="Attempt outcomes">
            <ul className="space-y-1.5 text-sm">
              {Object.entries(m.attempts.byOutcome)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => (
                  <li key={k} className="flex items-center justify-between">
                    <StatusBadge value={k} />
                    <span className="font-mono tabular-nums">{n}</span>
                  </li>
                ))}
              {m.attempts.total === 0 && <li className="text-muted">No attempts yet.</li>}
            </ul>
            <p className="mt-3 text-xs text-muted">Generated {fmtDateTime(m.generatedAt)}</p>
          </Panel>
        </div>
      </div>
    </>
  );
}
