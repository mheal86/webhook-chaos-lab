import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useLang } from '../i18n';

type Tone = 'green' | 'red' | 'amber' | 'blue' | 'gray' | 'violet';

const TONES: Record<Tone, string> = {
  green: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  red: 'bg-rose-500/15 text-rose-300 ring-rose-500/40',
  amber: 'bg-amber-500/15 text-amber-300 ring-amber-500/40',
  blue: 'bg-sky-500/15 text-sky-300 ring-sky-500/40',
  gray: 'bg-slate-500/15 text-slate-300 ring-slate-500/40',
  violet: 'bg-violet-500/15 text-violet-300 ring-violet-500/40',
};

const STATUS: Record<string, { tone: Tone; icon: string; label?: string }> = {
  // delivery states
  succeeded: { tone: 'green', icon: '✓' },
  dead: { tone: 'red', icon: '✕' },
  retry_wait: { tone: 'amber', icon: '↻', label: 'retry wait' },
  in_flight: { tone: 'blue', icon: '▶', label: 'in flight' },
  queued: { tone: 'gray', icon: '…' },
  // attempt outcomes
  success: { tone: 'green', icon: '✓' },
  http_retryable: { tone: 'amber', icon: '↻', label: 'retryable HTTP error' },
  http_permanent: { tone: 'red', icon: '✕', label: 'permanent HTTP error' },
  network_error: { tone: 'amber', icon: '⚡', label: 'network error' },
  timeout: { tone: 'violet', icon: '⏱', label: 'timeout' },
  worker_lost: { tone: 'violet', icon: '☠', label: 'worker lost' },
  in_progress: { tone: 'blue', icon: '▶', label: 'in progress' },
  // run + assertion statuses
  running: { tone: 'blue', icon: '▶' },
  passed: { tone: 'green', icon: '✓' },
  failed: { tone: 'red', icon: '✕' },
  pending: { tone: 'amber', icon: '…' },
  open: { tone: 'gray', icon: '○' },
  // receiver results
  received: { tone: 'blue', icon: '▶' },
  processed: { tone: 'green', icon: '✓' },
  duplicate: { tone: 'gray', icon: '⧉' },
  stale: { tone: 'amber', icon: '⌛' },
  conflict: { tone: 'red', icon: '⚠' },
  rejected_signature: { tone: 'red', icon: '🔒', label: 'rejected signature' },
  rejected_bad_request: { tone: 'red', icon: '✕', label: 'bad request' },
  injected_failure: { tone: 'amber', icon: '⚡', label: 'injected failure' },
  error: { tone: 'red', icon: '✕' },
};

const STATUS_VI: Record<string, string> = {
  succeeded: 'thành công',
  dead: 'dead (bỏ cuộc)',
  retry_wait: 'chờ thử lại',
  in_flight: 'đang gửi',
  queued: 'đang chờ',
  success: 'thành công',
  http_retryable: 'lỗi HTTP, sẽ thử lại',
  http_permanent: 'lỗi HTTP vĩnh viễn',
  network_error: 'lỗi mạng',
  timeout: 'timeout',
  worker_lost: 'mất worker',
  in_progress: 'đang chạy',
  running: 'đang chạy',
  passed: 'đạt',
  failed: 'không đạt',
  pending: 'đang chờ',
  open: 'mở',
  received: 'đã nhận',
  processed: 'đã xử lý',
  duplicate: 'trùng',
  stale: 'cũ, bỏ qua',
  conflict: 'xung đột',
  rejected_signature: 'chữ ký sai',
  rejected_bad_request: 'request sai',
  injected_failure: 'lỗi cố ý',
  error: 'lỗi',
};

/** Status colour is always paired with an icon and a text label (not colour alone). */
export function StatusBadge({ value }: { value: string }) {
  const { lang } = useLang();
  const s = STATUS[value] ?? { tone: 'gray' as Tone, icon: '•' };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[s.tone]}`}
    >
      <span aria-hidden="true">{s.icon}</span>
      {(lang === 'vi' ? STATUS_VI[value] : undefined) ?? s.label ?? value.replace(/_/g, ' ')}
    </span>
  );
}

export function Panel({
  title,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-line bg-panel ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold tracking-wide text-slate-200">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageTitle({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useLang();
  return (
    <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-500 border-t-transparent" />
      {label ?? t('Loading…', 'Đang tải…')}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center">
      <p className="font-medium text-slate-200">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useLang();
  const msg =
    error instanceof ApiError
      ? `${error.message} (HTTP ${error.status})`
      : String((error as Error)?.message ?? error);
  return (
    <div
      role="alert"
      className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200"
    >
      <p className="font-medium">{t('Something went wrong', 'Đã có lỗi xảy ra')}</p>
      <p className="mt-1 break-words">{msg}</p>
      {retry && (
        <button
          className="mt-2 rounded border border-rose-400/50 px-2 py-1 text-xs hover:bg-rose-500/20"
          onClick={retry}
        >
          {t('Retry', 'Thử lại')}
        </button>
      )}
    </div>
  );
}

export function Stat({
  id,
  label,
  value,
  hint,
  tone,
}: {
  /** Stable test id (labels are translated); defaults to the label. */
  id?: string;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div
      className="rounded-lg border border-line bg-panel p-4"
      data-testid={`stat-${(id ?? label).toLowerCase().replace(/\W+/g, '-')}`}
    >
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${tone ? TONES[tone].split(' ')[1] : 'text-white'}`}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export const btn =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-line bg-panel-2 px-3 py-1.5 text-sm font-medium text-slate-100 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50';
export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50';
export const inputCls =
  'w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500';

export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  const { t } = useLang();
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + limit);
  return (
    <nav
      aria-label="Pagination"
      className="mt-3 flex items-center justify-between text-sm text-muted"
    >
      <span>
        {from}–{to} {t('of', '/')} {total}
      </span>
      <span className="flex gap-2">
        <button
          className={btn}
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          {t('Previous', 'Trước')}
        </button>
        <button
          className={btn}
          disabled={offset + limit >= total}
          onClick={() => onChange(offset + limit)}
        >
          {t('Next', 'Sau')}
        </button>
      </span>
    </nav>
  );
}

export const fmtTime = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleTimeString(undefined, { hour12: false }) +
      '.' +
      String(new Date(iso).getMilliseconds()).padStart(3, '0')
    : '—';

export const fmtDateTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString(undefined, { hour12: false }) : '—';

export const shortId = (id: string | null | undefined): string => (id ? id.slice(0, 8) : '—');

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-bg px-1 py-0.5 font-mono text-xs text-sky-200">{children}</code>
  );
}

export function Json({ value }: { value: unknown }) {
  let text: string;
  if (typeof value === 'string') {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      text = value;
    }
  } else text = JSON.stringify(value, null, 2);
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-xs leading-relaxed text-slate-200">
      {text}
    </pre>
  );
}
