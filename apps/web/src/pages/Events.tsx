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
import { useLang } from '../i18n';

const LIMIT = 15;

export function Events() {
  const { runId } = useSelectedRun();
  const { t } = useLang();
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
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setOffset(0);
    };

  return (
    <>
      <PageTitle
        title="Events"
        subtitle={t(
          'Every business event the lab sent. Click an event id to see each HTTP attempt on a timeline. One event can have several deliveries (duplicates, replays).',
          'Mọi event nghiệp vụ mà lab đã gửi. Bấm vào id của event để xem từng lần gọi HTTP trên dòng thời gian. Một event có thể có nhiều delivery (bản trùng, bản gửi lại).',
        )}
      />
      <Panel>
        <form
          className="grid gap-3 md:grid-cols-5"
          onSubmit={(e) => e.preventDefault()}
          aria-label={t('Event filters', 'Bộ lọc event')}
        >
          <label className="text-xs text-muted md:col-span-2">
            {t('Event id or aggregate', 'Id event hoặc aggregate')}
            <input
              className={`${inputCls} mt-1`}
              value={q}
              onChange={(e) => reset(setQ)(e.target.value)}
              placeholder={t('uuid or text', 'uuid hoặc chữ')}
            />
          </label>
          <label className="text-xs text-muted">
            {t('Type', 'Loại')}
            <select
              className={`${inputCls} mt-1`}
              value={type}
              onChange={(e) => reset(setType)(e.target.value)}
            >
              <option value="">{t('All types', 'Tất cả loại')}</option>
              {EVENT_TYPE_LIST.map((ty) => (
                <option key={ty}>{ty}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            {t('Has delivery in state', 'Có delivery ở trạng thái')}
            <select
              className={`${inputCls} mt-1`}
              value={state}
              onChange={(e) => reset(setState)(e.target.value)}
            >
              <option value="">{t('Any', 'Bất kỳ')}</option>
              {DELIVERY_STATES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-end gap-2 pb-1.5 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={allRuns}
              onChange={(e) => reset(setAllRuns)(e.target.checked)}
            />
            {t('All runs', 'Mọi lần chạy')}
          </label>
        </form>
      </Panel>

      <div className="mt-4">
        {events.isError ? (
          <ErrorState error={events.error} retry={() => void events.refetch()} />
        ) : !events.data ? (
          <Loading />
        ) : events.data.items.length === 0 ? (
          <EmptyState
            title={t('No events match', 'Không có event nào khớp')}
            hint={t('Run a scenario or relax the filters.', 'Chạy một kịch bản hoặc nới bộ lọc.')}
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-left text-sm" data-testid="events-table">
                <caption className="sr-only">Events</caption>
                <thead className="bg-panel text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="px-3 py-2">Event</th>
                    <th className="px-3 py-2">{t('Type', 'Loại')}</th>
                    <th className="px-3 py-2">Aggregate</th>
                    <th className="px-3 py-2">Seq</th>
                    <th className="px-3 py-2">Deliveries</th>
                    <th className="px-3 py-2">{t('Created', 'Tạo lúc')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-panel/40">
                  {events.data.items.map((e) => (
                    <tr key={e.id} className="hover:bg-panel-2">
                      <td className="px-3 py-2">
                        <Link
                          className="inline-flex items-center gap-1.5 font-mono text-sky-300 hover:underline"
                          to={`/events/${e.id}`}
                        >
                          <span>{shortId(e.id)}</span>
                          <span className="font-sans text-xs text-muted">
                            ({t('timeline', 'xem từng lần thử')} →)
                          </span>
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
