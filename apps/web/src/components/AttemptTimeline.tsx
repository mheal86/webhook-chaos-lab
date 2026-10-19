import type { AttemptDto } from '@lab/shared/web';
import { useLang } from '../i18n';
import { StatusBadge, fmtTime } from './ui';

/** Vertical timeline of HTTP attempts. Timeouts are shown as "unknown at sender", never as a failure of the receiver. */
export function AttemptTimeline({ attempts }: { attempts: AttemptDto[] }) {
  const { t } = useLang();
  if (attempts.length === 0)
    return (
      <p className="text-sm text-muted">
        {t('No attempt has been made yet.', 'Chưa có lần thử nào.')}
      </p>
    );
  return (
    <ol
      className="relative ml-2 space-y-4 border-l border-line pl-5"
      data-testid="attempt-timeline"
    >
      {attempts.map((a) => (
        <li key={a.id} className="relative" data-testid={`attempt-${a.attemptNo}`}>
          <span
            aria-hidden="true"
            className="absolute -left-[1.62rem] top-1 h-2.5 w-2.5 rounded-full border border-slate-400 bg-bg"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-semibold text-white">
              {t('Attempt', 'Lần thử')} {a.attemptNo}
            </span>
            <StatusBadge value={a.outcome} />
            <span className="text-muted">gen {a.generation}</span>
            <span className="font-mono text-xs text-muted">{fmtTime(a.startedAt)}</span>
            {a.httpStatus !== null && (
              <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs">
                HTTP {a.httpStatus}
              </span>
            )}
            {a.durationMs !== null && (
              <span className="font-mono text-xs text-muted">{a.durationMs} ms</span>
            )}
            {a.errorCode && <span className="font-mono text-xs text-amber-300">{a.errorCode}</span>}
          </div>
          {a.unknownAtSender && (
            <p className="mt-1 text-xs text-violet-300">
              {t(
                'Outcome unknown at the sender: the receiver may or may not have processed this request. Receiver-side idempotency decides what happens on retry.',
                'Sender không biết kết quả: receiver có thể đã xử lý hoặc chưa. Cơ chế idempotency ở receiver quyết định chuyện gì xảy ra khi thử lại.',
              )}
            </p>
          )}
          {a.scheduledRetryAt && (
            <p className="mt-1 text-xs text-amber-200">
              {t('Next retry scheduled for', 'Lần thử tiếp theo lúc')}{' '}
              <span className="font-mono">{fmtTime(a.scheduledRetryAt)}</span>
              {a.retryAfterApplied
                ? t(' (extended by Retry-After)', ' (kéo dài theo Retry-After)')
                : ''}
            </p>
          )}
          {a.lateResult && (
            <p className="mt-1 text-xs text-slate-400">
              {t(
                'Late report from a worker that had lost its lease (ignored): HTTP',
                'Báo cáo trễ từ worker đã mất lease (bị bỏ qua): HTTP',
              )}{' '}
              {a.lateResult.httpStatus ?? '—'} {a.lateResult.errorCode ?? ''}
            </p>
          )}
          {a.responsePreview && (
            <pre className="mt-1 max-h-24 overflow-auto rounded border border-line bg-bg p-2 font-mono text-xs text-slate-300">
              {a.responsePreview}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}
