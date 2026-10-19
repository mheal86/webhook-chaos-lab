import type { ReactNode } from 'react';
import type { AssertionResult, AttemptDto } from '@lab/shared/web';
import { useLang, type Lang } from '../i18n';

/**
 * Plain-language copy and visuals that explain what the lab does to someone who has never seen
 * it: the delivery pipeline, where each scenario injects its fault, and a one-line verdict.
 */

export type StageKey = 'app' | 'db' | 'queue' | 'worker' | 'receiver';

const STAGES: Array<{ key: StageKey; icon: string; title: string; role: [string, string] }> = [
  {
    key: 'app',
    icon: '📨',
    title: 'API',
    role: ['accepts the event, answers 202', 'nhận event, trả 202'],
  },
  {
    key: 'db',
    icon: '🗄️',
    title: 'PostgreSQL',
    role: ['source of truth: event + outbox', 'nguồn sự thật: event + outbox'],
  },
  {
    key: 'queue',
    icon: '📬',
    title: 'Redis queue',
    role: ['only wakes the worker up', 'chỉ để đánh thức worker'],
  },
  {
    key: 'worker',
    icon: '⚙️',
    title: 'Worker',
    role: ['signs, sends, retries', 'ký, gửi, thử lại'],
  },
  {
    key: 'receiver',
    icon: '🎯',
    title: 'Receiver',
    role: ['verifies, applies once', 'kiểm tra, áp dụng 1 lần'],
  },
];

interface StoryText {
  title: string;
  /** What the lab breaks on purpose. */
  breaks: string;
  /** What must still be true afterwards. */
  mustHold: string;
  /** Why this happens in real systems. */
  why: string;
}

interface StoryEntry {
  icon: string;
  /** Stage where the fault is injected (highlighted in the pipeline). */
  fault?: StageKey;
  en: StoryText;
  vi: StoryText;
}

export type ScenarioStory = StoryText & { icon: string; fault?: StageKey };

const SCENARIO_STORY: Record<string, StoryEntry> = {
  healthy: {
    icon: '🌤️',
    en: {
      title: 'Healthy',
      breaks: 'Nothing. This is the baseline.',
      mustHold: 'Every event is delivered on the first try and applied exactly once.',
      why: 'A reference run to compare the broken scenarios against.',
    },
    vi: {
      title: 'Bình thường',
      breaks: 'Không phá gì cả. Đây là mốc so sánh.',
      mustHold: 'Mọi event được giao ngay lần đầu và áp dụng đúng một lần.',
      why: 'Lần chạy chuẩn để so với các kịch bản có lỗi.',
    },
  },
  fail_twice: {
    icon: '🔁',
    fault: 'receiver',
    en: {
      title: 'Fail twice then recover',
      breaks: 'The receiver answers HTTP 500 on the 1st and 2nd try.',
      mustHold:
        'The worker retries with backoff, the 3rd try succeeds, the effect is applied once.',
      why: 'Real servers go down for a few seconds. A webhook must not be lost because of that.',
    },
    vi: {
      title: 'Lỗi 2 lần rồi hồi phục',
      breaks: 'Receiver trả HTTP 500 ở lần thử thứ 1 và thứ 2.',
      mustHold:
        'Worker thử lại có giãn cách (backoff), lần 3 thành công, effect chỉ áp dụng 1 lần.',
      why: 'Server thật có lúc sập vài giây. Webhook không được mất chỉ vì vậy.',
    },
  },
  duplicate_storm: {
    icon: '🌪️',
    fault: 'worker',
    en: {
      title: 'Duplicate storm',
      breaks: 'The same event is sent 20 times at the same moment.',
      mustHold: 'The receiver applies it once and flags the other 19 as duplicates.',
      why: 'Retries mean duplicates will happen. Without idempotency a customer gets charged twice.',
    },
    vi: {
      title: 'Bão gửi trùng',
      breaks: 'Cùng một event bị gửi 20 lần cùng lúc.',
      mustHold: 'Receiver chỉ áp dụng 1 lần, 19 lần còn lại báo là trùng (duplicate).',
      why: 'Có retry thì chắc chắn có gửi trùng. Không có idempotency thì khách bị trừ tiền 2 lần.',
    },
  },
  timeout_after_commit: {
    icon: '⏱️',
    fault: 'receiver',
    en: {
      title: 'Timeout after commit',
      breaks: 'The receiver saves the effect, then replies slower than the sender waits.',
      mustHold:
        'The sender records “outcome unknown”, retries, the receiver says “duplicate”: still 1 effect.',
      why: 'A timeout does not mean the request failed. It means the sender does not know.',
    },
    vi: {
      title: 'Timeout sau khi đã commit',
      breaks: 'Receiver đã lưu effect, rồi trả lời chậm hơn thời gian sender chịu chờ.',
      mustHold: 'Sender ghi “không biết kết quả”, thử lại, receiver báo “trùng”: vẫn chỉ 1 effect.',
      why: 'Timeout không có nghĩa là request thất bại, mà là sender không biết kết quả.',
    },
  },
  out_of_order: {
    icon: '🔀',
    fault: 'receiver',
    en: {
      title: 'Out-of-order snapshots',
      breaks: 'Three order snapshots arrive in the order 3, 1, 2.',
      mustHold: 'The receiver keeps version 3 and ignores the two older snapshots.',
      why: 'Networks and retries reorder messages. Old data must never overwrite new data.',
    },
    vi: {
      title: 'Snapshot đến sai thứ tự',
      breaks: 'Ba snapshot của đơn hàng đến theo thứ tự 3, 1, 2.',
      mustHold: 'Receiver giữ phiên bản 3 và bỏ qua hai snapshot cũ hơn.',
      why: 'Mạng và retry làm tin nhắn đến lộn xộn. Dữ liệu cũ không được ghi đè dữ liệu mới.',
    },
  },
  exhaust_and_replay: {
    icon: '🪦',
    fault: 'receiver',
    en: {
      title: 'Exhaust retries and replay',
      breaks: 'The receiver fails every try until the retry budget runs out.',
      mustHold:
        'The delivery lands in Dead letters with its full history; a manual replay then succeeds.',
      why: 'After an outage, operators need a safe way to resend what was given up on.',
    },
    vi: {
      title: 'Hết lượt thử rồi gửi lại',
      breaks: 'Receiver lỗi ở mọi lần thử cho tới khi hết lượt.',
      mustHold:
        'Delivery vào mục Dead letters, giữ nguyên lịch sử; gửi lại thủ công (replay) thì thành công.',
      why: 'Sau sự cố, người vận hành cần cách gửi lại an toàn những gì hệ thống đã bỏ cuộc.',
    },
  },
  invalid_signature: {
    icon: '🔒',
    fault: 'worker',
    en: {
      title: 'Invalid signature',
      breaks: 'The request is signed with the wrong secret.',
      mustHold: 'The receiver rejects it with 401, it is not retried, and nothing is applied.',
      why: 'Anyone can POST to a public URL. Forged webhooks must never be applied.',
    },
    vi: {
      title: 'Chữ ký sai',
      breaks: 'Request được ký bằng sai khóa bí mật (secret).',
      mustHold: 'Receiver từ chối với 401, không thử lại, không áp dụng gì cả.',
      why: 'Ai cũng có thể POST vào một URL công khai. Webhook giả không bao giờ được áp dụng.',
    },
  },
};

export const SCENARIO_KEYS = Object.keys(SCENARIO_STORY);

export function storyFor(type: string | undefined, lang: Lang): ScenarioStory | undefined {
  const s = type ? SCENARIO_STORY[type] : undefined;
  return s && { icon: s.icon, fault: s.fault, ...s[lang] };
}

/** Localised scenario story lookup plus a title helper (falls back to the API title). */
export function useStories() {
  const { lang } = useLang();
  return {
    story: (type: string | undefined) => storyFor(type, lang),
    title: (type: string | undefined, fallback = type ?? '') =>
      type === 'manual'
        ? lang === 'vi'
          ? 'Khu thử thủ công'
          : 'Manual workspace'
        : (storyFor(type, lang)?.title ?? fallback),
  };
}

/** Left-to-right picture of the delivery pipeline; wraps to a column on narrow screens. */
export function PipelineDiagram({
  fault,
  counts,
  compact = false,
}: {
  fault?: StageKey;
  counts?: Partial<Record<StageKey, ReactNode>>;
  compact?: boolean;
}) {
  const { t } = useLang();
  return (
    <ol
      aria-label={t('Delivery pipeline', 'Đường đi của event')}
      className="flex flex-col items-stretch gap-2 md:flex-row md:items-center"
    >
      {STAGES.map((s, i) => {
        const broken = s.key === fault;
        return (
          <li key={s.key} className="flex flex-col items-stretch gap-2 md:flex-1 md:flex-row">
            <div
              className={`relative flex-1 rounded-lg border px-3 ${compact ? 'py-2' : 'py-3'} ${
                broken ? 'border-amber-400/70 bg-amber-500/10' : 'border-line bg-panel-2'
              }`}
            >
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="text-lg leading-none">
                  {s.icon}
                </span>
                <span className="whitespace-nowrap text-sm font-semibold text-white">
                  {s.title}
                </span>
              </div>
              {!compact && <p className="mt-1 text-xs text-muted">{t(...s.role)}</p>}
              {counts?.[s.key] !== undefined && (
                <p className="mt-1.5 text-xs text-slate-200">{counts[s.key]}</p>
              )}
              {broken && (
                <span className="absolute -top-2.5 right-2 whitespace-nowrap rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-900">
                  ⚡ {t('fault here', 'lỗi ở đây')}
                </span>
              )}
            </div>
            {i < STAGES.length - 1 && (
              <span aria-hidden="true" className="self-center text-muted md:px-0.5">
                <span className="md:hidden">↓</span>
                <span className="hidden md:inline">→</span>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const VERDICT = {
  passed: {
    cls: 'border-emerald-500/50 bg-emerald-500/10',
    icon: '✅',
    head: ['The system recovered correctly', 'Hệ thống đã tự phục hồi đúng'],
  },
  failed: {
    cls: 'border-rose-500/50 bg-rose-500/10',
    icon: '❌',
    head: ['An expectation did not hold', 'Có kỳ vọng không đạt'],
  },
  running: {
    cls: 'border-sky-500/50 bg-sky-500/10',
    icon: '⏳',
    head: ['Running… the lab is injecting faults', 'Đang chạy… lab đang gây lỗi'],
  },
} as const;

/** One-glance answer to “did it work?” for a scenario run. */
export function VerdictBanner({
  status,
  title,
  assertions,
  story,
}: {
  status: string;
  title: string;
  assertions: AssertionResult[];
  story?: ScenarioStory;
}) {
  const { t } = useLang();
  const v = VERDICT[status as keyof typeof VERDICT] ?? VERDICT.running;
  const passed = assertions.filter((a) => a.status === 'passed').length;
  return (
    <div className={`rounded-lg border p-4 ${v.cls}`} data-testid="verdict">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span aria-hidden="true" className="text-2xl leading-none">
          {v.icon}
        </span>
        <p className="text-base font-semibold text-white">{t(v.head[0], v.head[1])}</p>
        <span className="text-sm text-slate-300">
          {title} · {passed}/{assertions.length} {t('checks passed', 'kiểm tra đạt')}
        </span>
      </div>
      {story && (
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-amber-300">
              {t('What we broke', 'Đã phá cái gì')}
            </dt>
            <dd className="mt-0.5 text-slate-200">{story.breaks}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
              {t('What had to stay true', 'Điều gì vẫn phải đúng')}
            </dt>
            <dd className="mt-0.5 text-slate-200">{story.mustHold}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

const STRIP: Record<string, { cls: string; mark: string }> = {
  success: { cls: 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200', mark: '✓' },
  http_permanent: { cls: 'border-rose-500/60 bg-rose-500/15 text-rose-200', mark: '✕' },
  timeout: { cls: 'border-violet-500/60 bg-violet-500/15 text-violet-200', mark: '?' },
  worker_lost: { cls: 'border-violet-500/60 bg-violet-500/15 text-violet-200', mark: '?' },
  in_progress: { cls: 'border-sky-500/60 bg-sky-500/15 text-sky-200', mark: '…' },
};
const STRIP_RETRY = { cls: 'border-amber-500/60 bg-amber-500/15 text-amber-200', mark: '↻' };

/** Compact “try 1 ✕ → try 2 ✕ → try 3 ✓” summary shown above the detailed timeline. */
export function AttemptStrip({ attempts }: { attempts: AttemptDto[] }) {
  const { t } = useLang();
  if (attempts.length === 0) return null;
  return (
    <ol
      aria-label={t('Attempts at a glance', 'Tóm tắt các lần thử')}
      className="flex flex-wrap items-center gap-1.5"
    >
      {attempts.map((a, i) => {
        const s = STRIP[a.outcome] ?? STRIP_RETRY;
        const code =
          a.httpStatus ?? (a.unknownAtSender ? t('unknown', 'không rõ') : (a.errorCode ?? ''));
        return (
          <li key={a.id} className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-xs ${s.cls}`}
              title={a.outcome.replace(/_/g, ' ')}
            >
              <span aria-hidden="true">{s.mark}</span>
              {t('try', 'lần')} {a.attemptNo}
              <span className="opacity-80">· {code}</span>
            </span>
            {i < attempts.length - 1 && (
              <span aria-hidden="true" className="text-muted">
                →
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Small “i” hint box used to explain a page in one or two sentences. */
export function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="mb-5 flex gap-3 rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-3 text-sm text-slate-300">
      <span aria-hidden="true" className="text-sky-300">
        ℹ️
      </span>
      <div>{children}</div>
    </div>
  );
}
