import { NavLink, Outlet } from 'react-router-dom';
import { useRuns, useScenarios, useSelectedRun } from '../api/hooks';
import { useLang, type Lang } from '../i18n';
import { useStories } from './explain';
import { StatusBadge, fmtDateTime, shortId } from './ui';

const NAV: Array<{ to: string; label: [string, string]; end?: boolean }> = [
  { to: '/', label: ['Overview', 'Tổng quan'], end: true },
  { to: '/runner', label: ['Scenario Runner', 'Chạy kịch bản'] },
  { to: '/events', label: ['Events', 'Events'] },
  { to: '/dead-letters', label: ['Dead Letters', 'Dead letters'] },
  { to: '/receiver', label: ['Receiver Inspector', 'Phía receiver'] },
  { to: '/how-it-works', label: ['How it works', 'Cách hoạt động'] },
];

const STATUS_MARK: Record<string, string> = { passed: '✓', failed: '✕', running: '…' };

function RunSelector() {
  const runs = useRuns();
  const scenarios = useScenarios();
  const { runId, setRunId } = useSelectedRun();
  const { t } = useLang();
  const stories = useStories();
  const title = (type: string) =>
    stories.title(type, scenarios.data?.scenarios.find((s) => s.type === type)?.title ?? type);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">{t('Run', 'Lần chạy')}</span>
      <select
        aria-label={t('Selected run', 'Lần chạy đang xem')}
        className="max-w-[22rem] rounded-md border border-line bg-bg px-2 py-1.5 text-slate-100"
        value={runId ?? ''}
        onChange={(e) => setRunId(e.target.value)}
        disabled={!runs.data?.length}
      >
        {!runs.data?.length && <option value="">{t('No runs yet', 'Chưa có lần chạy')}</option>}
        {runs.data?.map((r) => (
          <option key={r.id} value={r.id}>
            {STATUS_MARK[r.status] ?? '○'} {stories.story(r.type)?.icon ?? ''} {title(r.type)} ·{' '}
            {fmtDateTime(r.createdAt)} · {shortId(r.id)}
          </option>
        ))}
      </select>
    </label>
  );
}

function LangSwitch() {
  const { lang, setLang, t } = useLang();
  const options: Array<[Lang, string]> = [
    ['en', 'EN'],
    ['vi', 'VI'],
  ];
  return (
    <div
      role="group"
      aria-label={t('Language', 'Ngôn ngữ')}
      className="inline-flex rounded-md border border-line bg-bg p-0.5 text-xs font-semibold"
    >
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={lang === value}
          onClick={() => setLang(value)}
          data-testid={`lang-${value}`}
          className={`rounded px-2 py-1 ${
            lang === value ? 'bg-sky-600 text-white' : 'text-muted hover:text-slate-200'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Layout() {
  const runs = useRuns();
  const { runId } = useSelectedRun();
  const { t } = useLang();
  const selected = runs.data?.find((r) => r.id === runId);
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-sky-600 focus:px-3 focus:py-2"
      >
        {t('Skip to content', 'Bỏ qua tới nội dung')}
      </a>
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="text-xl">
              ⚡
            </span>
            <div>
              <span className="block text-base font-semibold leading-tight text-white">
                Webhook Chaos Lab
              </span>
              <span className="block text-xs text-muted">
                {t(
                  'inject failures · watch retries · prove exactly-once effects',
                  'gây lỗi có chủ đích · xem hệ thống thử lại · chứng minh effect đúng 1 lần',
                )}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {selected && <StatusBadge value={selected.status} />}
            <RunSelector />
            <LangSwitch />
          </div>
        </div>
        <nav aria-label="Main" className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-3">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
                  isActive
                    ? 'border-sky-400 text-white'
                    : 'border-transparent text-muted hover:text-slate-200'
                }`
              }
            >
              {t(...n.label)}
            </NavLink>
          ))}
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
