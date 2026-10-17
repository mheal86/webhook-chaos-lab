import { NavLink, Outlet } from 'react-router-dom';
import { useRuns, useSelectedRun } from '../api/hooks';
import { StatusBadge, fmtDateTime, shortId } from './ui';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/runner', label: 'Scenario Runner' },
  { to: '/events', label: 'Events' },
  { to: '/dead-letters', label: 'Dead Letters' },
  { to: '/receiver', label: 'Receiver Inspector' },
];

function RunSelector() {
  const runs = useRuns();
  const { runId, setRunId } = useSelectedRun();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted">Run</span>
      <select
        aria-label="Selected run"
        className="max-w-[22rem] rounded-md border border-line bg-bg px-2 py-1.5 text-slate-100"
        value={runId ?? ''}
        onChange={(e) => setRunId(e.target.value)}
        disabled={!runs.data?.length}
      >
        {!runs.data?.length && <option value="">No runs yet</option>}
        {runs.data?.map((r) => (
          <option key={r.id} value={r.id}>
            {r.type} · {r.status} · {shortId(r.id)} · {fmtDateTime(r.createdAt)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Layout() {
  const runs = useRuns();
  const { runId } = useSelectedRun();
  const selected = runs.data?.find((r) => r.id === runId);
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-sky-600 focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="text-xl">
              ⚡
            </span>
            <span className="text-base font-semibold text-white">Webhook Chaos Lab</span>
          </div>
          <div className="flex items-center gap-3">
            {selected && <StatusBadge value={selected.status} />}
            <RunSelector />
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
              {n.label}
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
