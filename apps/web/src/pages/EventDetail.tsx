import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useEvent, useReplay } from '../api/hooks';
import { AttemptTimeline } from '../components/AttemptTimeline';
import { AttemptStrip, Hint } from '../components/explain';
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
import { useLang } from '../i18n';

export function EventDetailPage() {
  const { id } = useParams();
  const event = useEvent(id);
  const replay = useReplay();
  const { t } = useLang();

  if (event.isError) {
    return event.error instanceof ApiError && event.error.status === 404 ? (
      <ErrorState error={new Error(t('Event not found', 'Không tìm thấy event'))} />
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
            {e.type} · aggregate <Code>{e.aggregateId}</Code> · sequence {e.sequence} ·{' '}
            {t('created', 'tạo lúc')} {fmtDateTime(e.createdAt)}
          </>
        }
        actions={
          <Link className="text-sm text-sky-300 hover:underline" to="/events">
            {t('← All events', '← Tất cả event')}
          </Link>
        }
      />

      <Hint>
        {t(
          <>
            An <b>event</b> is the fact itself (shown in the Payload panel). Each <b>delivery</b> is
            one plan to send it to the receiver, and each <b>attempt</b> is one real HTTP call. A
            delivery keeps trying until it gets a 2xx or runs out of attempts.
          </>,
          <>
            <b>Event</b> là bản thân sự kiện (hiển thị trong khung Payload). Mỗi <b>delivery</b> là
            một lần “định gửi” event đó tới receiver, còn mỗi <b>attempt</b> (lần thử) là một HTTP
            call thật. Delivery sẽ thử tiếp cho tới khi nhận 2xx hoặc hết lượt.
          </>,
        )}
      </Hint>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel
          title={t('Payload (raw, signed bytes)', 'Payload (bytes gốc, đã ký)')}
          className="lg:col-span-1"
        >
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
            {t(
              'Retries and replays resend exactly these bytes; only the timestamp and signature are fresh per attempt.',
              'Mỗi lần thử lại hay replay đều gửi đúng các bytes này; chỉ timestamp và chữ ký là mới mỗi lần.',
            )}
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
                      {t('Replay', 'Gửi lại')}
                    </button>
                  )
                }
              >
                <div className="mb-4">
                  <AttemptStrip attempts={d.attempts} />
                </div>
                <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted">{t('Attempts', 'Số lần thử')}</dt>
                    <dd className="font-mono">
                      {d.attemptCount}/{d.maxAttempts}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Generation</dt>
                    <dd className="font-mono">{d.generation}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{t('Next attempt', 'Lần thử tới')}</dt>
                    <dd>{d.nextAttemptAt ? fmtDateTime(d.nextAttemptAt) : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">{t('Finished', 'Kết thúc')}</dt>
                    <dd>{fmtDateTime(d.finishedAt)}</dd>
                  </div>
                  {d.terminalReason && (
                    <div>
                      <dt className="text-xs text-muted">
                        {t('Terminal reason', 'Lý do kết thúc')}
                      </dt>
                      <dd className="font-mono text-rose-300">{d.terminalReason}</dd>
                    </div>
                  )}
                  {d.lastErrorCode && (
                    <div>
                      <dt className="text-xs text-muted">{t('Last error', 'Lỗi gần nhất')}</dt>
                      <dd className="font-mono text-amber-300">{d.lastErrorCode}</dd>
                    </div>
                  )}
                  {d.replayOfDeliveryId && (
                    <div className="col-span-2">
                      <dt className="text-xs text-muted">{t('Replay of', 'Gửi lại từ')}</dt>
                      <dd className="font-mono">
                        {shortId(d.replayOfDeliveryId)}{' '}
                        <span className="text-muted">
                          {t('(original keeps its history)', '(bản gốc giữ nguyên lịch sử)')}
                        </span>
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
              {t('Replay created: new delivery', 'Đã tạo bản gửi lại: delivery mới')}{' '}
              {shortId(replay.data.deliveryId)} {t('for the same event.', 'cho cùng event.')}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
