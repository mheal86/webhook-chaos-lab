import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  useCreateRun,
  useMetrics,
  useRun,
  useRuns,
  useScenarios,
  useSelectedRun,
} from '../api/hooks';
import { AssertionsTable } from '../components/Assertions';
import { PipelineDiagram, VerdictBanner, useStories } from '../components/explain';
import {
  ErrorState,
  Loading,
  PageTitle,
  Panel,
  Stat,
  StatusBadge,
  btn,
  btnPrimary,
  fmtDateTime,
  shortId,
} from '../components/ui';
import { useLang } from '../i18n';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Welcome() {
  const { t } = useLang();
  const steps: Array<[string, string, string]> = [
    [
      '1',
      t('Pick a failure', 'Chọn một loại lỗi'),
      t(
        'Receiver down, duplicates, timeout, wrong signature…',
        'Receiver sập, gửi trùng, timeout, sai chữ ký…',
      ),
    ],
    [
      '2',
      t('Press Run', 'Bấm Run'),
      t(
        'The lab sends events and injects the fault you chose.',
        'Lab gửi event và gây đúng loại lỗi bạn chọn.',
      ),
    ],
    [
      '3',
      t('Read the verdict', 'Đọc kết luận'),
      t(
        'Expected vs actual, straight from PostgreSQL.',
        'So kỳ vọng với thực tế, đếm thẳng từ PostgreSQL.',
      ),
    ],
  ];
  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-line bg-gradient-to-br from-panel to-panel-2 p-6 md:p-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-sky-300">
          Webhook Chaos Lab
        </p>
        <h1 className="mt-2 max-w-3xl text-2xl font-semibold text-white md:text-3xl">
          {t(
            'Break webhook delivery on purpose, then prove nothing was lost or applied twice.',
            'Cố tình làm hỏng việc gửi webhook, rồi chứng minh không có gì bị mất hay bị áp dụng 2 lần.',
          )}
        </h1>
        <p className="mt-3 max-w-3xl text-sm text-slate-300">
          {t(
            'A webhook is an HTTP call one system makes to tell another “something happened” (a payment succeeded, an order shipped). Networks fail, servers time out, requests arrive twice or out of order. This lab injects those failures and checks, against the database, that every event is still delivered and its effect is applied exactly once.',
            'Webhook là một HTTP call mà hệ thống này gửi sang hệ thống khác để báo “có chuyện vừa xảy ra” (thanh toán thành công, đơn hàng đã giao). Mạng thì rớt, server thì timeout, request đến 2 lần hoặc sai thứ tự. Lab này cố tình gây ra những lỗi đó rồi kiểm tra trong database rằng mọi event vẫn được giao và effect của nó chỉ được áp dụng đúng một lần.',
          )}
        </p>
        <Link to="/runner" className={`${btnPrimary} mt-5`}>
          {t('Run your first scenario →', 'Chạy kịch bản đầu tiên →')}
        </Link>
      </section>

      <Panel title={t('How an event travels', 'Một event đi qua những đâu')}>
        <PipelineDiagram />
      </Panel>

      <div className="grid gap-4 md:grid-cols-3">
        {steps.map(([n, title, d]) => (
          <div key={n} className="rounded-lg border border-line bg-panel p-4">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-sky-600 text-sm font-bold text-white">
              {n}
            </span>
            <p className="mt-2 font-medium text-white">{title}</p>
            <p className="mt-1 text-sm text-muted">{d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuickTourBanner({ currentType }: { currentType?: string }) {
  const runs = useRuns();
  const create = useCreateRun();
  const { setRunId } = useSelectedRun();
  const navigate = useNavigate();
  const { t } = useLang();
  const [collapsed, setCollapsed] = useState(false);

  const openScenario = async (scenarioType: string, goTo?: string) => {
    const existing = runs.data?.find((r) => r.type === scenarioType);
    if (existing) {
      setRunId(existing.id);
    } else {
      await create.mutateAsync({ type: scenarioType });
    }
    if (goTo) navigate(goTo);
  };

  if (collapsed) {
    return (
      <div className="mb-4 flex items-center justify-between rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-2 text-xs text-slate-300">
        <span>
          {t(
            'New to Webhook Chaos Lab? Open the 30-second guided tour.',
            'Lần đầu xem Webhook Chaos Lab? Mở hướng dẫn trải nghiệm nhanh 30 giây.',
          )}
        </span>
        <button
          type="button"
          className="font-semibold text-sky-300 hover:underline"
          onClick={() => setCollapsed(false)}
        >
          {t('Show guide', 'Hiện hướng dẫn')}
        </button>
      </div>
    );
  }

  const tours: Array<{
    step: string;
    scenario: string;
    goTo?: string;
    title: string;
    desc: string;
    takeaway: string;
  }> = [
    {
      step: '1',
      scenario: 'fail_twice',
      title: t('Auto-recover after crash', 'Tự phục hồi khi server lỗi 2 lần'),
      desc: t(
        'Receiver crashes twice (HTTP 500); worker retries with backoff and succeeds on try #3.',
        'Server nhận lỗi 2 lần (HTTP 500); worker tự chờ giãn cách rồi thử lại và thành công ở lần 3.',
      ),
      takeaway: t(
        'Watch below: ⚡ fault on Receiver → 3 HTTP tries, 1 effect.',
        'Xem bên dưới: ⚡ lỗi ở Receiver → 3 lần gọi HTTP, đúng 1 effect.',
      ),
    },
    {
      step: '2',
      scenario: 'duplicate_storm',
      title: t('Block 20× duplicate storm', 'Chặn bão gửi trùng 20 lần'),
      desc: t(
        'Same payment arrives 20 times at once — idempotency applies it once, ignores 19 duplicates.',
        'Cùng 1 sự kiện bắn tới 20 lần — idempotency chỉ xử lý 1 lần, bỏ qua 19 bản trùng.',
      ),
      takeaway: t(
        'Watch below: 20 requests received → only 1 business effect.',
        'Xem bên dưới: 20 request tới receiver → chỉ đúng 1 business effect.',
      ),
    },
    {
      step: '3',
      scenario: 'exhaust_and_replay',
      goTo: '/dead-letters',
      title: t('Inspect Dead Letter & Replay', 'Xem Dead Letter & bấm thử Replay'),
      desc: t(
        'Retries run out → full error history saved in Dead Letters. Jump there & click Replay.',
        'Hết lượt thử → lưu toàn bộ lịch sử vào Dead Letters. Mở thẳng tab đó và bấm thử Replay.',
      ),
      takeaway: t(
        'Opens Dead Letters directly with error history + Replay button.',
        'Mở thẳng sang trang Dead Letters với lịch sử lỗi và nút Gửi lại.',
      ),
    },
  ];

  return (
    <section
      aria-label={t('30-second guided tour', 'Hướng dẫn trải nghiệm nhanh 30 giây')}
      className="mb-6 rounded-xl border border-sky-500/40 bg-gradient-to-br from-panel via-panel to-panel-2 p-4 md:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-4xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-sky-300">
            {t('New here? 30-second guided demo', 'Lần đầu xem? Trải nghiệm nhanh trong 30 giây')}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-200">
            {t(
              <>
                Imagine a <b>Payment Gateway</b> notifying an <b>ERP / Order system</b> via HTTP (a
                webhook). If the network drops, servers return errors, or retries fire 20 times at
                once, how do we prove <b>zero lost orders</b> and <b>zero double-processing</b>?
                Pick a step below — sample chaos runs are already loaded:
              </>,
              <>
                Hãy hình dung <b>Cổng thanh toán</b> gửi thông báo đơn hàng sang{' '}
                <b>Hệ thống ERP / Kho</b> qua HTTP (webhook). Nếu mạng rớt, server sập, hoặc request
                bị gửi trùng 20 lần — làm sao chứng minh <b>không mất đơn</b> và{' '}
                <b>không xử lý trùng 2 lần</b>? Bấm 1 trong 3 kịch bản mẫu bên dưới để kiểm chứng:
              </>,
            )}
          </p>
        </div>
        <button
          type="button"
          className="text-xs text-muted hover:text-white"
          onClick={() => setCollapsed(true)}
        >
          {t('Hide guide', 'Ẩn hướng dẫn')}
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {tours.map((item) => {
          const active = currentType === item.scenario && !item.goTo;
          return (
            <button
              key={item.scenario}
              type="button"
              disabled={create.isPending}
              onClick={() => void openScenario(item.scenario, item.goTo)}
              className={`group flex flex-col justify-between rounded-lg border p-3.5 text-left transition-colors ${
                active
                  ? 'border-sky-400 bg-sky-500/15'
                  : 'border-line bg-bg/60 hover:border-sky-500/60 hover:bg-panel-2'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-sky-600 text-xs font-bold text-white">
                    {item.step}
                  </span>
                  <span className="text-xs font-semibold text-sky-300 group-hover:underline">
                    {item.goTo
                      ? t('Open Dead Letters →', 'Mở Dead Letters →')
                      : active
                        ? t('Viewing below ✓', 'Đang xem bên dưới ✓')
                        : t('Load below →', 'Xem kết quả →')}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold text-white">{item.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-300">{item.desc}</p>
              </div>
              <p className="mt-2.5 border-t border-line/70 pt-2 text-[11px] text-emerald-300">
                {item.takeaway}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-3 text-xs">
        <Link to="/runner" className={btn}>
          ▶{' '}
          {t(
            'Simulate live fault in Scenario Runner →',
            'Tự bấm chạy mô phỏng ở Scenario Runner →',
          )}
        </Link>
        <Link to="/events" className="text-sky-300 hover:underline">
          {t(
            'Inspect HTTP attempt timeline (Events) →',
            'Xem dòng thời gian từng lần thử (Events) →',
          )}
        </Link>
        <Link to="/how-it-works" className="text-sky-300 hover:underline">
          {t('5-min architecture explainer →', 'Giải thích kiến trúc (đọc 5 phút) →')}
        </Link>
      </div>
    </section>
  );
}

export function Overview() {
  const { runId } = useSelectedRun();
  const run = useRun(runId);
  const metrics = useMetrics(runId);
  const scenarios = useScenarios();
  const runs = useRuns();
  const { t, lang } = useLang();
  const stories = useStories();
  const noScenarioYet = runs.data?.every((x) => x.type === 'manual') ?? false;

  if (!runId || noScenarioYet) return <Welcome />;
  if (metrics.isError)
    return <ErrorState error={metrics.error} retry={() => void metrics.refetch()} />;
  if (!metrics.data) return <Loading />;

  const m = metrics.data;
  const retrying = m.deliveries.queued + m.deliveries.in_flight + m.deliveries.retry_wait;
  const lat = m.attempts.latency;
  const r = run.data;
  const isScenario = r && r.type !== 'manual';
  const title = stories.title(
    r?.type,
    scenarios.data?.scenarios.find((s) => s.type === r?.type)?.title ?? r?.type ?? '',
  );
  const story = stories.story(r?.type);
  const vi = lang === 'vi';

  return (
    <>
      <QuickTourBanner currentType={r?.type} />
      <PageTitle
        title={t('Overview', 'Tổng quan')}
        subtitle={t(
          'What happened in the selected run, counted straight from PostgreSQL.',
          'Chuyện gì đã xảy ra trong lần chạy đang chọn, đếm thẳng từ PostgreSQL.',
        )}
        actions={
          r && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <StatusBadge value={r.status} />
              <span>
                {title} · seed {r.seed} · {shortId(r.id)}
              </span>
            </div>
          )
        }
      />

      {isScenario && (
        <div className="mb-5">
          <VerdictBanner status={r.status} title={title} assertions={r.assertions} story={story} />
        </div>
      )}

      <Panel title={t('Where the events went', 'Các event đã đi qua đâu')} className="mb-5">
        <PipelineDiagram
          fault={story?.fault}
          counts={
            vi
              ? {
                  app: `${m.events} event đã nhận`,
                  db: `${m.deliveries.total} delivery đã lưu`,
                  queue: retrying ? `${retrying} đang chờ` : 'không còn gì chờ',
                  worker: `${m.attempts.total} lần gọi HTTP`,
                  receiver: `${m.receiver.requests} request → ${m.businessEffects} effect`,
                }
              : {
                  app: `${plural(m.events, 'event')} accepted`,
                  db: `${plural(m.deliveries.total, 'delivery', 'deliveries')} stored`,
                  queue: retrying ? `${retrying} waiting` : 'nothing waiting',
                  worker: plural(m.attempts.total, 'HTTP try', 'HTTP tries'),
                  receiver: `${plural(m.receiver.requests, 'request')} → ${plural(m.businessEffects, 'effect')}`,
                }
          }
        />
        <p className="mt-3 text-xs text-muted">
          {t(
            'More requests than effects is expected: duplicates and retries reach the receiver, but its idempotency check applies each event only once.',
            'Số request nhiều hơn số effect là bình thường: bản trùng và lần thử lại vẫn tới receiver, nhưng bước kiểm tra idempotency chỉ áp dụng mỗi event một lần.',
          )}
        </p>
      </Panel>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {t('Sender side', 'Phía gửi (sender)')}
      </h2>
      <div
        className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6"
        data-testid="overview-stats"
      >
        <Stat
          id="events"
          label="Events"
          value={m.events}
          hint={t('business facts to announce', 'sự kiện nghiệp vụ cần báo')}
        />
        <Stat
          id="deliveries"
          label="Deliveries"
          value={m.deliveries.total}
          hint={t('one event can have several', 'một event có thể có nhiều')}
        />
        <Stat
          id="succeeded"
          label={t('Succeeded', 'Thành công')}
          value={m.deliveries.succeeded}
          tone="green"
          hint={t('got a 2xx answer', 'nhận được trả lời 2xx')}
        />
        <Stat
          id="dead"
          label="Dead"
          value={m.deliveries.dead}
          tone={m.deliveries.dead ? 'red' : undefined}
          hint={t('gave up: out of retries or rejected', 'bỏ cuộc: hết lượt thử hoặc bị từ chối')}
        />
        <Stat
          id="retrying"
          label={t('Retrying', 'Đang thử lại')}
          value={retrying}
          tone={retrying ? 'amber' : undefined}
          hint={t('not finished yet', 'chưa xong')}
        />
        <Stat
          id="http-attempts"
          label={t('HTTP attempts', 'Lần gọi HTTP')}
          value={m.attempts.total}
          hint={`${m.attempts.byOutcome.success} ok · ${m.attempts.byOutcome.timeout} timeout`}
        />
      </div>

      <h2 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider text-muted">
        {t('Receiver side', 'Phía nhận (receiver)')}
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat
          id="requests-received"
          label={t('Requests received', 'Request đã nhận')}
          value={m.receiver.requests}
          hint={t('including duplicates', 'tính cả bản trùng')}
        />
        <Stat
          id="business-effects"
          label="Business effects"
          value={m.businessEffects}
          tone="blue"
          hint={t(
            'changes actually applied: should equal events',
            'thay đổi thật sự được áp dụng: phải bằng số event',
          )}
        />
        <Stat
          id="receiver-duplicates"
          label={t('Receiver duplicates', 'Receiver báo trùng')}
          value={m.receiver.byResult.duplicate}
          hint={`${t('ignored safely', 'bỏ qua an toàn')} · ${m.receiver.byResult.stale} stale · ${m.receiver.byResult.conflict} conflict`}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Panel
          title={t('Expected vs actual', 'Kỳ vọng và thực tế')}
          className="lg:col-span-2"
          action={
            <Link to="/runner" className="text-sm text-sky-300 hover:underline">
              {t('Scenario Runner →', 'Chạy kịch bản →')}
            </Link>
          }
        >
          {r && r.assertions.length > 0 ? (
            <AssertionsTable assertions={r.assertions} />
          ) : (
            <p className="text-sm text-muted">
              {t(
                'This run has no scenario expectations (manual workspace).',
                'Lần chạy này không có kỳ vọng nào (khu thử thủ công).',
              )}
            </p>
          )}
          {r?.failureReason && (
            <p className="mt-3 text-sm text-rose-300">
              {t('Failure reason:', 'Lý do thất bại:')} {r.failureReason}
            </p>
          )}
        </Panel>

        <div className="space-y-5">
          <Panel title={t('Attempt latency (p95)', 'Độ trễ mỗi lần gọi (p95)')}>
            <div className="text-2xl font-semibold tabular-nums">
              {lat.p95 === null ? '—' : `${lat.p95} ${lat.unit}`}
            </div>
            <p className="mt-2 text-xs text-muted">
              {t(
                '95% of HTTP tries answered faster than this. Nearest-rank p95 over',
                '95% số lần gọi HTTP được trả lời nhanh hơn mức này. p95 (nearest-rank) trên',
              )}{' '}
              <b>{lat.sampleCount}</b> {t('samples.', 'mẫu.')}
            </p>
          </Panel>
          <Panel title={t('Attempt outcomes', 'Kết quả các lần thử')}>
            <ul className="space-y-1.5 text-sm">
              {Object.entries(m.attempts.byOutcome)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => (
                  <li key={k} className="flex items-center justify-between">
                    <StatusBadge value={k} />
                    <span className="font-mono tabular-nums">{n}</span>
                  </li>
                ))}
              {m.attempts.total === 0 && (
                <li className="text-muted">{t('No attempts yet.', 'Chưa có lần thử nào.')}</li>
              )}
            </ul>
            <p className="mt-3 text-xs text-muted">
              {t('Generated', 'Cập nhật lúc')} {fmtDateTime(m.generatedAt)}
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
