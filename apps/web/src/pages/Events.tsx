import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DELIVERY_STATES, EVENT_TYPE_LIST } from '@lab/shared/web';
import { useEvents, useSelectedRun } from '../api/hooks';
import {
  EmptyState,
  ErrorState,
  Loading,
  PageTitle,
  Pager,
  Panel,
  StatusBadge,
  fmtDateTime,
  inputCls,
  shortId,
} from '../components/ui';

const LIMIT = 15;

export function Events() {
  const { runId } = useSelectedRun();
  const [allRuns, setAllRuns] = useState(false);
  const [type, setType] = useState('');
  const [state, setState] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const events = useEvents({
    runId: allRuns ? undefined : runId,
    type: type || undefined,
    state: state || undefined,
    q: q.trim() || undefined,
    limit: LIMIT,
    offset,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setOffset(0);
  };

  return (
    <>
      <PageTitle title="Events" subtitle="Immutable business events. One event can have several deliveries (duplicates, replays)." />
      <Panel>
        <form className="grid gap-3 md:grid-cols-5" onSubmit={(e) => e.preventDefault()} aria-label="Event filters">
          <label className="text-xs text-muted md:col-span-2">
            Event id or aggregate
            <input className={`${inputCls} mt-1`} value={q} onChange={(e) => reset(setQ)(e.target.value)} placeholder="uuid or text" />
          </label>
          <label className="text-xs text-muted">
            Type
            <select className={`${inputCls} mt-1`} value={type} onChange={(e) => reset(setType)(e.target.value)}>
              <option value="">All types</option>
              {EVENT_TYPE_LIST.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Has delivery in state
            <select className={`${inputCls} mt-1`} value={state} onChange={(e) => reset(setState)(e.target.value)}>
              <option value="">Any</option>
              {DELIVERY_STATES.map((s) => (
                <option key={s} value={s}>{s.replace('_', ' ')}</option>
              ))}
            </select>
          </label>
          <label className="flex items-end gap-2 pb-1.5 text-sm text-slate-300">
            <input type="checkbox" checked={allRuns} onChange={(e) => reset(setAllRuns)(e.target.checked)} />
            All runs
          </label>
        </form>
      </Panel>

      <div className="mt-4">
        {events.isError ? (
          <ErrorState error={events.error} retry={() => void events.refetch()} />
        ) : !events.data ? (
          <Loading />
        ) : events.data.items.length === 0 ? (
          <EmptyState title="No events match" hint="Run a scenario or relax the filters." />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-left text-sm" data-testid="events-table">
                <caption className="sr-only">Events</caption>
                <thead className="bg-panel text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-3 py-2">Event</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Aggregate</th>
                    <th className="px-3 py-2">Seq</th>
                    <th className="px-3 py-2">Deliveries</th>
                    <th className="px-3 py-2">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-panel/40">
                  {events.data.items.map((e) => (
                    <tr key={e.id} className="hover:bg-panel-2">
                      <td className="px-3 py-2">
                        <Link className="font-mono text-sky-300 hover:underline" to={`/events/${e.id}`}>
                          {shortId(e.id)}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{e.type}</td>
                      <td className="px-3 py-2">{e.aggregateId}</td>
                      <td className="px-3 py-2 font-mono">{e.sequence}</td>
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap gap-1">
                          {Object.entries(e.deliveryStates).map(([s, n]) => (
                            <span key={s} className="inline-flex items-center gap-1">
                              <StatusBadge value={s} />
                              {n! > 1 && <span className="font-mono text-xs text-muted">×{n}</span>}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted">{fmtDateTime(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={events.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />
          </>
        )}
      </div>
    </>
  );
}
