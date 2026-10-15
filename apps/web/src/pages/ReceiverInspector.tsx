import { Link } from 'react-router-dom';
import { useReceiverState, useSelectedRun } from '../api/hooks';
import {
  EmptyState,
  ErrorState,
  Json,
  Loading,
  PageTitle,
  Panel,
  Stat,
  StatusBadge,
  fmtTime,
  shortId,
} from '../components/ui';

export function ReceiverInspector() {
  const { runId } = useSelectedRun();
  const state = useReceiverState(runId);

  if (!runId) return <EmptyState title="No run selected" hint="Start a scenario first." />;
  if (state.isError) return <ErrorState error={state.error} retry={() => void state.refetch()} />;
  if (!state.data) return <Loading />;
  const s = state.data;
  const r = s.summary.byResult;

  return (
    <>
      <PageTitle
        title="Receiver Inspector"
        subtitle="What the fixture receiver actually saw and did for this run: every HTTP request, duplicates and stale snapshots it ignored, and the business effects it applied. Requests listed newest first."
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="receiver-summary">
        <Stat label="Requests" value={s.summary.requests} />
        <Stat label="Processed" value={r.processed} tone="green" />
        <Stat label="Duplicates" value={r.duplicate} />
        <Stat label="Stale" value={r.stale} tone={r.stale ? 'amber' : undefined} />
        <Stat label="Business effects" value={s.summary.businessEffects} tone="blue" />
      </div>
      <p className="mt-2 text-xs text-muted">
        Rejected signature {r.rejected_signature} · bad request {r.rejected_bad_request} · conflict {r.conflict} ·
        injected failures {r.injected_failure} · errors {r.error}
        {s.summary.receiveOrder ? ` · receive order (event sequence): ${s.summary.receiveOrder}` : ''}
      </p>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Panel title="Projections" className="lg:col-span-1">
          <h3 className="text-xs uppercase tracking-wider text-muted">Counter</h3>
          {s.counter ? (
            <p className="mb-4 text-lg font-semibold tabular-nums" data-testid="counter-value">
              {s.counter.aggregateId} = {s.counter.value}
            </p>
          ) : (
            <p className="mb-4 text-sm text-muted">No counter events applied.</p>
          )}
          <h3 className="text-xs uppercase tracking-wider text-muted">Order</h3>
          {s.order ? (
            <div data-testid="order-projection">
              <p className="mb-2 text-lg font-semibold tabular-nums">
                {s.order.aggregateId} at sequence {s.order.sequence}
              </p>
              <Json value={s.order.state} />
            </div>
          ) : (
            <p className="text-sm text-muted">No order snapshot applied.</p>
          )}
          <h3 className="mb-2 mt-5 text-xs uppercase tracking-wider text-muted">Business effects ({s.effects.length})</h3>
          {s.effects.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            <ul className="space-y-1 text-xs" data-testid="effects">
              {s.effects.slice(0, 20).map((e) => (
                <li key={e.id} className="flex justify-between gap-2 rounded bg-bg px-2 py-1">
                  <span className="font-mono">{e.kind}</span>
                  <Link className="font-mono text-sky-300 hover:underline" to={`/events/${e.eventId}`}>{shortId(e.eventId)}</Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="HTTP requests received" className="lg:col-span-2">
          {s.requests.length === 0 ? (
            <p className="text-sm text-muted">The receiver has not received any request for this run.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="receiver-requests">
                <caption className="sr-only">Receiver requests</caption>
                <thead className="text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">Time</th>
                    <th className="py-2 pr-3">Event seq</th>
                    <th className="py-2 pr-3">Attempt</th>
                    <th className="py-2 pr-3">Result</th>
                    <th className="py-2 pr-3">HTTP</th>
                    <th className="py-2">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {s.requests.map((q) => (
                    <tr key={q.id}>
                      <td className="py-1.5 pr-3 font-mono text-muted">{q.seq}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{fmtTime(q.receivedAt)}</td>
                      <td className="py-1.5 pr-3 font-mono">{q.eventSequence ?? '—'}</td>
                      <td className="py-1.5 pr-3 font-mono">{q.attemptNo ?? '—'}</td>
                      <td className="py-1.5 pr-3"><StatusBadge value={q.result} /></td>
                      <td className="py-1.5 pr-3 font-mono">{q.httpStatus ?? '…'}</td>
                      <td className="py-1.5 text-xs text-muted">
                        {q.signatureValid === false ? 'signature invalid · ' : ''}
                        {q.detail ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
