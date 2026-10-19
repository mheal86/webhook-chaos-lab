import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDeadLetters, useReplay, useSelectedRun } from '../api/hooks';
import { AttemptTimeline } from '../components/AttemptTimeline';
import { AttemptStrip } from '../components/explain';
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
import { useLang } from '../i18n';

const LIMIT = 10;

export function DeadLetters() {
  const { runId } = useSelectedRun();
  const [allRuns, setAllRuns] = useState(false);
  const [offset, setOffset] = useState(0);
  const dead = useDeadLetters({ runId: allRuns ? undefined : runId, limit: LIMIT, offset });
  const replay = useReplay();
  const { t } = useLang();

  return (
    <>
      <PageTitle
        title="Dead Letters"
        subtitle={t(
          'Deliveries the system gave up on: out of retries, or rejected for good (e.g. a bad signature). Replay sends the same event again as a new delivery; the dead one keeps its full history. “Dead” at the sender does not prove the receiver never processed it.',
          'Những delivery hệ thống đã bỏ cuộc: hết lượt thử, hoặc bị từ chối vĩnh viễn (ví dụ sai chữ ký). Nút Gửi lại (Replay) gửi lại cùng event dưới dạng một delivery mới; delivery dead vẫn giữ nguyên lịch sử. “Dead” ở phía gửi không chứng minh receiver chưa từng xử lý nó.',
        )}
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
            {t('All runs', 'Mọi lần chạy')}
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
          {t('Replay created: delivery', 'Đã tạo bản gửi lại: delivery')}{' '}
          {shortId(replay.data.deliveryId)} ({t('replay of', 'gửi lại từ')}{' '}
          {shortId(replay.data.replayOfDeliveryId)}).
        </p>
      )}

      {dead.isError ? (
        <ErrorState error={dead.error} retry={() => void dead.refetch()} />
      ) : !dead.data ? (
        <Loading />
      ) : dead.data.items.length === 0 ? (
        <EmptyState
          title={t('No dead letters', 'Không có dead letter nào')}
          hint={t(
            'Run “Exhaust retries and replay” or “Invalid signature” to produce some.',
            'Chạy kịch bản “Hết lượt thử rồi gửi lại” hoặc “Chữ ký sai” để tạo ra.',
          )}
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
                    {d.activeReplays > 0
                      ? t('Replay in progress', 'Đang gửi lại')
                      : t('Replay', 'Gửi lại')}
                  </button>
                }
              >
                <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-5">
                  <div>
                    <dt className="text-xs text-muted">Delivery</dt>
                    <dd className="font-mono">{shortId(d.id)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{t('Reason', 'Lý do')}</dt>
                    <dd className="font-mono text-rose-300">{d.terminalReason ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{t('Last error', 'Lỗi gần nhất')}</dt>
                    <dd className="font-mono text-amber-300">{d.lastErrorCode ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{t('Attempts', 'Số lần thử')}</dt>
                    <dd className="font-mono">
                      {d.attemptCount}/{d.maxAttempts}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{t('Replays so far', 'Đã gửi lại')}</dt>
                    <dd className="font-mono">{d.replayCount}</dd>
                  </div>
                </dl>
                <div className="mb-3">
                  <AttemptStrip attempts={d.attempts} />
                </div>
                <details>
                  <summary className="cursor-pointer text-sm text-sky-300">
                    {t('Attempt history', 'Lịch sử các lần thử')} ({d.attempts.length}) ·{' '}
                    {t('died', 'dead lúc')} {fmtDateTime(d.finishedAt)}
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
