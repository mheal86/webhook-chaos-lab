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
import { useLang } from '../i18n';

export function ReceiverInspector() {
  const { runId } = useSelectedRun();
  const state = useReceiverState(runId);
  const { t } = useLang();

  if (!runId)
    return (
      <EmptyState
        title={t('No run selected', 'Chưa chọn lần chạy')}
        hint={t('Start a scenario first.', 'Hãy chạy một kịch bản trước.')}
      />
    );
  if (state.isError) return <ErrorState error={state.error} retry={() => void state.refetch()} />;
  if (!state.data) return <Loading />;
  const s = state.data;
  const r = s.summary.byResult;

  return (
    <>
      <PageTitle
        title={t('Receiver Inspector', 'Phía receiver')}
        subtitle={t(
          'The other side of the wire: every HTTP request the receiver got, which ones it safely ignored (duplicates, stale snapshots) and the business effects it actually applied. Effects = events means nothing was applied twice. Newest requests first.',
          'Đầu bên kia của đường truyền: mọi HTTP request receiver nhận được, những cái nó bỏ qua an toàn (bản trùng, snapshot cũ) và các business effect nó thật sự áp dụng. Số effect = số event nghĩa là không có gì bị áp dụng 2 lần. Request mới nhất ở trên cùng.',
        )}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="receiver-summary">
        <Stat id="requests" label={t('Requests', 'Request')} value={s.summary.requests} />
        <Stat id="processed" label={t('Processed', 'Đã xử lý')} value={r.processed} tone="green" />
        <Stat id="duplicates" label={t('Duplicates', 'Bản trùng')} value={r.duplicate} />
        <Stat
          id="stale"
          label={t('Stale', 'Snapshot cũ')}
          value={r.stale}
          tone={r.stale ? 'amber' : undefined}
        />
        <Stat label="Business effects" value={s.summary.businessEffects} tone="blue" />
      </div>
      <p className="mt-2 text-xs text-muted">
        {t('Rejected signature', 'Sai chữ ký')} {r.rejected_signature} ·{' '}
        {t('bad request', 'request sai')} {r.rejected_bad_request} · {t('conflict', 'xung đột')}{' '}
        {r.conflict} · {t('injected failures', 'lỗi cố ý')} {r.injected_failure} ·{' '}
        {t('errors', 'lỗi')} {r.error}
        {s.summary.receiveOrder
          ? ` · ${t('receive order (event sequence)', 'thứ tự nhận (theo sequence)')}: ${s.summary.receiveOrder}`
          : ''}
      </p>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Panel
          title={t('Projections', 'Trạng thái hiện tại (projection)')}
          className="lg:col-span-1"
        >
          <h3 className="text-xs uppercase tracking-wider text-muted">{t('Counter', 'Bộ đếm')}</h3>
          {s.counter ? (
            <p className="mb-4 text-lg font-semibold tabular-nums" data-testid="counter-value">
              {s.counter.aggregateId} = {s.counter.value}
            </p>
          ) : (
            <p className="mb-4 text-sm text-muted">
              {t('No counter events applied.', 'Chưa áp dụng event bộ đếm nào.')}
            </p>
          )}
          <h3 className="text-xs uppercase tracking-wider text-muted">{t('Order', 'Đơn hàng')}</h3>
          {s.order ? (
            <div data-testid="order-projection">
              <p className="mb-2 text-lg font-semibold tabular-nums">
                {s.order.aggregateId} {t('at sequence', 'ở sequence')} {s.order.sequence}
              </p>
              <Json value={s.order.state} />
            </div>
          ) : (
            <p className="text-sm text-muted">
              {t('No order snapshot applied.', 'Chưa áp dụng snapshot đơn hàng nào.')}
            </p>
          )}
          <h3 className="mb-2 mt-5 text-xs uppercase tracking-wider text-muted">
            Business effects ({s.effects.length})
          </h3>
          {s.effects.length === 0 ? (
            <p className="text-sm text-muted">{t('None.', 'Chưa có.')}</p>
          ) : (
            <ul className="space-y-1 text-xs" data-testid="effects">
              {s.effects.slice(0, 20).map((e) => (
                <li key={e.id} className="flex justify-between gap-2 rounded bg-bg px-2 py-1">
                  <span className="font-mono">{e.kind}</span>
                  <Link
                    className="font-mono text-sky-300 hover:underline"
                    to={`/events/${e.eventId}`}
                  >
                    {shortId(e.eventId)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title={t('HTTP requests received', 'Các HTTP request đã nhận')}
          className="lg:col-span-2"
        >
          {s.requests.length === 0 ? (
            <p className="text-sm text-muted">
              {t(
                'The receiver has not received any request for this run.',
                'Receiver chưa nhận request nào cho lần chạy này.',
              )}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="receiver-requests">
                <caption className="sr-only">Receiver requests</caption>
                <thead className="text-xs uppercase tracking-wider text-muted">
                  <tr>
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">{t('Time', 'Thời điểm')}</th>
                    <th className="py-2 pr-3">Event seq</th>
                    <th className="py-2 pr-3">{t('Attempt', 'Lần thử')}</th>
                    <th className="py-2 pr-3">{t('Result', 'Kết quả')}</th>
                    <th className="py-2 pr-3">HTTP</th>
                    <th className="py-2">{t('Detail', 'Chi tiết')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {s.requests.map((q) => (
                    <tr key={q.id}>
                      <td className="py-1.5 pr-3 font-mono text-muted">{q.seq}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{fmtTime(q.receivedAt)}</td>
                      <td className="py-1.5 pr-3 font-mono">{q.eventSequence ?? '—'}</td>
                      <td className="py-1.5 pr-3 font-mono">{q.attemptNo ?? '—'}</td>
                      <td className="py-1.5 pr-3">
                        <StatusBadge value={q.result} />
                      </td>
                      <td className="py-1.5 pr-3 font-mono">{q.httpStatus ?? '…'}</td>
                      <td className="py-1.5 text-xs text-muted">
                        {q.signatureValid === false
                          ? t('signature invalid · ', 'chữ ký sai · ')
                          : ''}
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
