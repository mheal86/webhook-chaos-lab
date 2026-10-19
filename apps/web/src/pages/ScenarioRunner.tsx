import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RunConfig, ScenarioCatalogEntry } from '@lab/shared/web';
import { ApiError } from '../api/client';
import { useCreateRun, useRun, useScenarios, useSelectedRun } from '../api/hooks';
import { AssertionsTable } from '../components/Assertions';
import { PipelineDiagram, VerdictBanner, useStories } from '../components/explain';
import {
  Code,
  ErrorState,
  Json,
  Loading,
  PageTitle,
  Panel,
  StatusBadge,
  btnPrimary,
  fmtDateTime,
  inputCls,
  shortId,
} from '../components/ui';
import { useLang } from '../i18n';

const FIELD_LABELS: Record<keyof RunConfig, [string, string]> = {
  eventCount: ['Events', 'Số event'],
  duplicateCount: ['Duplicate deliveries', 'Số bản gửi trùng'],
  maxAttempts: ['Max attempts', 'Số lần thử tối đa'],
  baseDelayMs: ['Backoff base (ms)', 'Thời gian chờ gốc (ms)'],
  capDelayMs: ['Backoff cap (ms)', 'Thời gian chờ tối đa (ms)'],
  jitter: ['Jitter (0–1)', 'Độ ngẫu nhiên jitter (0–1)'],
  maxRetryAfterMs: ['Max Retry-After (ms)', 'Retry-After tối đa (ms)'],
  httpTimeoutMs: ['HTTP timeout (ms)', 'HTTP timeout (ms)'],
  chaosRate: ['Chaos rate (0–0.9)', 'Tỉ lệ lỗi ngẫu nhiên (0–0.9)'],
};

export function ScenarioRunner() {
  const scenarios = useScenarios();
  const { runId, isActive } = useSelectedRun();
  const run = useRun(runId);
  const create = useCreateRun();
  const { t, lang } = useLang();
  const stories = useStories();
  const [type, setType] = useState<string>('healthy');
  const [seed, setSeed] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => setOverrides({}), [type]);
  // Until the user picks a scenario, follow the viewed run so the explanation matches its result.
  const [touched, setTouched] = useState(false);
  const viewedType = run.data && run.data.type !== 'manual' ? run.data.type : undefined;
  useEffect(() => {
    if (viewedType && !touched) setType(viewedType);
  }, [viewedType, touched]);

  if (scenarios.isError)
    return <ErrorState error={scenarios.error} retry={() => void scenarios.refetch()} />;
  if (!scenarios.data) return <Loading />;

  const { defaultConfig } = scenarios.data;
  const entry: ScenarioCatalogEntry =
    scenarios.data.scenarios.find((s) => s.type === type) ?? scenarios.data.scenarios[0]!;
  const story = stories.story(entry.type);
  const entryTitle = stories.title(entry.type, entry.title);

  const submit = () => {
    const config: Record<string, number> = {};
    for (const [k, v] of Object.entries(overrides)) if (v !== '') config[k] = Number(v);
    create.mutate({ type: entry.type, seed: seed === '' ? undefined : Number(seed), config });
  };

  const err = create.error instanceof ApiError ? create.error : null;
  const showRun = run.data && run.data.type !== 'manual' ? run.data : null;
  const runEntry = scenarios.data.scenarios.find((s) => s.type === showRun?.type);
  const runTitle = stories.title(showRun?.type, runEntry?.title ?? showRun?.type ?? '');

  return (
    <>
      <PageTitle
        title={t('Scenario Runner', 'Chạy kịch bản')}
        subtitle={t(
          'Pick a failure, press Run, and the lab checks against the database that the system still did the right thing.',
          'Chọn một loại lỗi, bấm Run, lab sẽ kiểm tra trong database xem hệ thống có còn làm đúng hay không.',
        )}
      />
      <div className="grid gap-5 lg:grid-cols-5">
        <Panel
          title={t('1. Pick a failure to inject', '1. Chọn lỗi muốn gây ra')}
          className="lg:col-span-2"
        >
          <fieldset>
            <legend className="sr-only">{t('Scenario preset', 'Kịch bản')}</legend>
            <div className="space-y-2">
              {scenarios.data.scenarios.map((s) => {
                const st = stories.story(s.type);
                const selected = s.type === type;
                return (
                  <label
                    key={s.type}
                    className={`flex cursor-pointer gap-3 rounded-md border p-3 transition-colors ${
                      selected
                        ? 'border-sky-500 bg-sky-500/10'
                        : 'border-line hover:border-slate-500'
                    }`}
                  >
                    <input
                      type="radio"
                      name="scenario"
                      value={s.type}
                      checked={selected}
                      onClick={() => setTouched(true)}
                      onChange={() => {
                        setTouched(true);
                        setType(s.type);
                      }}
                      className="sr-only"
                      data-testid={`scenario-${s.type}`}
                    />
                    <span aria-hidden="true" className="text-xl leading-6">
                      {st?.icon ?? '•'}
                    </span>
                    <span>
                      <span className="block text-sm font-medium text-white">
                        {stories.title(s.type, s.title)}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {st?.breaks ?? s.summary}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </Panel>

        <div className="space-y-5 lg:col-span-3">
          <Panel title={`2. ${story?.icon ?? ''} ${entryTitle}`}>
            {story && (
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                    {t('We break', 'Ta phá')}
                  </dt>
                  <dd className="mt-1 text-slate-200">{story.breaks}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
                    {t('Must stay true', 'Vẫn phải đúng')}
                  </dt>
                  <dd className="mt-1 text-slate-200">{story.mustHold}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-sky-300">
                    {t('Why it matters', 'Vì sao quan trọng')}
                  </dt>
                  <dd className="mt-1 text-slate-200">{story.why}</dd>
                </div>
              </dl>
            )}
            <div className="mt-4">
              <PipelineDiagram fault={story?.fault} compact />
            </div>
            {lang === 'en' && (
              <p className="mt-3 text-xs text-muted">Pass condition: {entry.expectation}</p>
            )}

            <div className="mt-4 border-t border-line pt-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">
                {t('Settings', 'Tùy chỉnh')}{' '}
                <span className="font-normal text-muted">
                  {t('(optional)', '(không bắt buộc)')}
                </span>
              </h3>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <label className="text-xs text-muted">
                  Seed
                  <input
                    className={`${inputCls} mt-1`}
                    inputMode="numeric"
                    placeholder={t('random (recorded)', 'ngẫu nhiên (có lưu lại)')}
                    value={seed}
                    onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))}
                  />
                </label>
                {entry.configurable.map((f) => (
                  <label key={f} className="text-xs text-muted">
                    {t(...FIELD_LABELS[f])}
                    <input
                      className={`${inputCls} mt-1`}
                      inputMode="decimal"
                      placeholder={String(defaultConfig[f])}
                      value={overrides[f] ?? ''}
                      aria-label={t(...FIELD_LABELS[f])}
                      onChange={(e) =>
                        setOverrides((o) => ({ ...o, [f]: e.target.value.replace(/[^\d.]/g, '') }))
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                {t(
                  'Empty fields use the defaults shown. The same seed reproduces the same faults.',
                  'Ô để trống sẽ dùng giá trị mặc định đang hiện mờ. Cùng một seed sẽ tạo lại đúng các lỗi đó.',
                )}
              </p>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                className={btnPrimary}
                onClick={submit}
                disabled={create.isPending || isActive}
                data-testid="run-button"
              >
                {create.isPending
                  ? t('Starting…', 'Đang khởi động…')
                  : isActive
                    ? t('A run is active…', 'Đang có lần chạy khác…')
                    : `▶ ${t('Run', 'Chạy')} “${entryTitle}”`}
              </button>
              <span className="text-xs text-muted">
                {t(
                  'One run at a time. Takes a few seconds.',
                  'Mỗi lần chỉ chạy một kịch bản. Mất vài giây.',
                )}
              </span>
            </div>
            {err && (
              <p role="alert" className="mt-3 text-sm text-rose-300" data-testid="run-error">
                {err.status === 409
                  ? t(
                      'Another run is still active. Wait for it to finish.',
                      'Đang có lần chạy khác. Chờ nó xong rồi thử lại.',
                    )
                  : err.message}
              </p>
            )}
          </Panel>

          <Panel
            title={
              showRun ? `3. ${t('Result', 'Kết quả')}: ${runTitle}` : `3. ${t('Result', 'Kết quả')}`
            }
            action={showRun && <StatusBadge value={showRun.status} />}
          >
            {!showRun ? (
              <p className="text-sm text-muted">
                {t(
                  'No run yet. Press Run above to start one.',
                  'Chưa có lần chạy nào. Bấm Run ở trên để bắt đầu.',
                )}
              </p>
            ) : (
              <div data-testid="run-result" data-status={showRun.status}>
                <VerdictBanner
                  status={showRun.status}
                  title={runTitle}
                  assertions={showRun.assertions}
                />
                <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-muted">
                  {t(
                    'Checks: what the scenario expected vs what the database recorded',
                    'Kiểm tra: kịch bản kỳ vọng gì, database ghi nhận gì',
                  )}
                </h3>
                <AssertionsTable assertions={showRun.assertions} />
                {showRun.failureReason && (
                  <p className="mt-3 text-sm text-rose-300">
                    {t('Failure reason:', 'Lý do thất bại:')} {showRun.failureReason}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-4 text-sm">
                  <Link className="text-sky-300 hover:underline" to="/events">
                    {t('See each attempt (Events) →', 'Xem từng lần thử (Events) →')}
                  </Link>
                  <Link className="text-sky-300 hover:underline" to="/dead-letters">
                    Dead letters →
                  </Link>
                  <Link className="text-sky-300 hover:underline" to="/receiver">
                    {t('What the receiver saw →', 'Receiver đã thấy gì →')}
                  </Link>
                </div>
                <details className="mt-4 rounded-md border border-line p-3">
                  <summary className="cursor-pointer text-sm text-slate-300">
                    {t('Run details', 'Chi tiết lần chạy')} · seed{' '}
                    <span className="font-mono">{showRun.seed}</span> · id{' '}
                    <span className="font-mono">{shortId(showRun.id)}</span>
                  </summary>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
                    <div>
                      <dt className="text-xs text-muted">{t('Phase', 'Giai đoạn')}</dt>
                      <dd className="font-mono">{showRun.phase}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">{t('Step', 'Bước')}</dt>
                      <dd className="font-mono">
                        {showRun.stepIndex}/{showRun.steps?.length ?? 0}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">{t('Started', 'Bắt đầu')}</dt>
                      <dd>{fmtDateTime(showRun.startedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted">{t('Finished', 'Kết thúc')}</dt>
                      <dd>{fmtDateTime(showRun.finishedAt)}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs text-muted">
                    {t(
                      'Faults are chosen from seed + event index + delivery ordinal + attempt number only. Stored fault plan and config:',
                      'Lỗi chỉ được quyết định từ seed + thứ tự event + thứ tự delivery + số lần thử. Fault plan và cấu hình đã lưu:',
                    )}{' '}
                    <Code>faultPlan</Code> · <Code>config</Code>
                  </p>
                  <div className="mt-2 grid gap-3 md:grid-cols-2">
                    <Json value={showRun.faultPlan} />
                    <Json value={showRun.config} />
                  </div>
                </details>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
