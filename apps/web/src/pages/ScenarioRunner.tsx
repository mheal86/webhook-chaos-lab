import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RunConfig, ScenarioCatalogEntry } from '@lab/shared/web';
import { ApiError } from '../api/client';
import { useCreateRun, useRun, useScenarios, useSelectedRun } from '../api/hooks';
import { AssertionsTable } from '../components/Assertions';
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

const FIELD_LABELS: Record<keyof RunConfig, string> = {
  eventCount: 'Events',
  duplicateCount: 'Duplicate deliveries',
  maxAttempts: 'Max attempts',
  baseDelayMs: 'Backoff base (ms)',
  capDelayMs: 'Backoff cap (ms)',
  jitter: 'Jitter (0–1)',
  maxRetryAfterMs: 'Max Retry-After (ms)',
  httpTimeoutMs: 'HTTP timeout (ms)',
  chaosRate: 'Chaos rate (0–0.9)',
};

export function ScenarioRunner() {
  const scenarios = useScenarios();
  const { runId, isActive } = useSelectedRun();
  const run = useRun(runId);
  const create = useCreateRun();
  const [type, setType] = useState<string>('healthy');
  const [seed, setSeed] = useState('');
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => setOverrides({}), [type]);

  if (scenarios.isError) return <ErrorState error={scenarios.error} retry={() => void scenarios.refetch()} />;
  if (!scenarios.data) return <Loading />;

  const { defaultConfig } = scenarios.data;
  const entry: ScenarioCatalogEntry = scenarios.data.scenarios.find((s) => s.type === type) ?? scenarios.data.scenarios[0]!;

  const submit = () => {
    const config: Record<string, number> = {};
    for (const [k, v] of Object.entries(overrides)) if (v !== '') config[k] = Number(v);
    create.mutate({ type: entry.type, seed: seed === '' ? undefined : Number(seed), config });
  };

  const err = create.error instanceof ApiError ? create.error : null;
  const showRun = run.data && run.data.type !== 'manual' ? run.data : null;

  return (
    <>
      <PageTitle
        title="Scenario Runner"
        subtitle="Choose a fault scenario, press Run, and compare what the scenario expected with what the database recorded. Only one run is active at a time; the same seed and config reproduce the same fault plan (not identical wall-clock timing)."
      />
      <div className="grid gap-5 lg:grid-cols-5">
        <Panel title="1. Scenario" className="lg:col-span-2">
          <fieldset>
            <legend className="sr-only">Scenario preset</legend>
            <div className="space-y-2">
              {scenarios.data.scenarios.map((s) => (
                <label
                  key={s.type}
                  className={`block cursor-pointer rounded-md border p-3 ${
                    s.type === type ? 'border-sky-500 bg-sky-500/10' : 'border-line hover:border-slate-500'
                  }`}
                >
                  <input
                    type="radio"
                    name="scenario"
                    value={s.type}
                    checked={s.type === type}
                    onChange={() => setType(s.type)}
                    className="sr-only"
                    data-testid={`scenario-${s.type}`}
                  />
                  <span className="block text-sm font-medium text-white">{s.title}</span>
                  <span className="mt-0.5 block text-xs text-muted">{s.summary}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 border-t border-line pt-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-200">2. Configuration</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">
                Seed
                <input
                  className={`${inputCls} mt-1`}
                  inputMode="numeric"
                  placeholder="random (recorded)"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))}
                />
              </label>
              {entry.configurable.map((f) => (
                <label key={f} className="text-xs text-muted">
                  {FIELD_LABELS[f]}
                  <input
                    className={`${inputCls} mt-1`}
                    inputMode="decimal"
                    placeholder={String(defaultConfig[f])}
                    value={overrides[f] ?? ''}
                    aria-label={FIELD_LABELS[f]}
                    onChange={(e) => setOverrides((o) => ({ ...o, [f]: e.target.value.replace(/[^\d.]/g, '') }))}
                  />
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">Empty fields use the defaults shown as placeholders. Limits are enforced by the API.</p>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button className={btnPrimary} onClick={submit} disabled={create.isPending || isActive} data-testid="run-button">
              {create.isPending ? 'Starting…' : isActive ? 'A run is active…' : `Run “${entry.title}”`}
            </button>
          </div>
          {err && (
            <p role="alert" className="mt-3 text-sm text-rose-300" data-testid="run-error">
              {err.status === 409 ? 'Another run is still active. Wait for it to finish.' : err.message}
            </p>
          )}
        </Panel>

        <div className="space-y-5 lg:col-span-3">
          <Panel
            title="3. Result"
            action={showRun && <StatusBadge value={showRun.status} />}
          >
            {!showRun ? (
              <p className="text-sm text-muted">No scenario run selected yet. Press Run to start one.</p>
            ) : (
              <div data-testid="run-result" data-status={showRun.status}>
                <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
                  <div><dt className="text-xs text-muted">Scenario</dt><dd>{showRun.type}</dd></div>
                  <div><dt className="text-xs text-muted">Seed</dt><dd className="font-mono">{showRun.seed}</dd></div>
                  <div><dt className="text-xs text-muted">Phase</dt><dd className="font-mono">{showRun.phase}</dd></div>
                  <div><dt className="text-xs text-muted">Step</dt><dd className="font-mono">{showRun.stepIndex}/{showRun.steps?.length ?? 0}</dd></div>
                  <div><dt className="text-xs text-muted">Started</dt><dd>{fmtDateTime(showRun.startedAt)}</dd></div>
                  <div><dt className="text-xs text-muted">Finished</dt><dd>{fmtDateTime(showRun.finishedAt)}</dd></div>
                  <div><dt className="text-xs text-muted">Run id</dt><dd className="font-mono">{shortId(showRun.id)}</dd></div>
                </dl>
                <AssertionsTable assertions={showRun.assertions} />
                {showRun.failureReason && <p className="mt-3 text-sm text-rose-300">Failure reason: {showRun.failureReason}</p>}
                <div className="mt-4 flex flex-wrap gap-4 text-sm">
                  <Link className="text-sky-300 hover:underline" to="/events">Events →</Link>
                  <Link className="text-sky-300 hover:underline" to="/dead-letters">Dead letters →</Link>
                  <Link className="text-sky-300 hover:underline" to="/receiver">Receiver inspector →</Link>
                </div>
              </div>
            )}
          </Panel>
          <Panel title="What this scenario proves">
            <p className="text-sm">{entry.expectation}</p>
            {showRun && showRun.type === entry.type && (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-300">Stored fault plan &amp; config snapshot</summary>
                <p className="mt-2 text-xs text-muted">
                  Faults are chosen from <Code>seed</Code> + event index + delivery ordinal + attempt number only.
                </p>
                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  <Json value={showRun.faultPlan} />
                  <Json value={showRun.config} />
                </div>
              </details>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
