import { decideFault, jitterUnitFor, seededUnit, type FaultPlan } from './faults';
import { buildBlueprint, resolveRunConfig, SCENARIO_TYPES } from './scenarios';
import { isUrlAllowed, parseAllowlist, parseRedisUrl } from './config';

describe('seededUnit', () => {
  it('is deterministic and within [0,1)', () => {
    const a = seededUnit(42, 'fail', 0, 1, 1);
    expect(a).toBe(seededUnit(42, 'fail', 0, 1, 1));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it('depends on every component', () => {
    const base = seededUnit(1, 'x', 0, 1, 1);
    expect(seededUnit(2, 'x', 0, 1, 1)).not.toBe(base);
    expect(seededUnit(1, 'x', 1, 1, 1)).not.toBe(base);
    expect(seededUnit(1, 'x', 0, 2, 1)).not.toBe(base);
    expect(seededUnit(1, 'x', 0, 1, 2)).not.toBe(base);
  });

  it('is roughly uniform', () => {
    let below = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) if (seededUnit(7, 'u', i) < 0.25) below++;
    expect(below / n).toBeGreaterThan(0.21);
    expect(below / n).toBeLessThan(0.29);
  });

  it('jitterUnitFor is stable per (seed, event, ordinal, attempt)', () => {
    const ctx = { eventIndex: 3, deliveryOrdinal: 2, attemptNo: 4 };
    expect(jitterUnitFor(9, ctx)).toBe(jitterUnitFor(9, { ...ctx }));
  });
});

describe('decideFault', () => {
  const plan: FaultPlan = {
    seed: 5,
    rules: [
      { phase: 1, eventIndex: 0, attemptNo: { from: 1, to: 2 }, action: { kind: 'respond', status: 500 } },
      { attemptNo: 3, deliveryOrdinal: 2, action: { kind: 'sign_invalid' } },
    ],
  };

  it('matches by phase, event index and attempt range', () => {
    expect(decideFault(plan, 1, { eventIndex: 0, deliveryOrdinal: 1, attemptNo: 1 })).toEqual({ kind: 'respond', status: 500 });
    expect(decideFault(plan, 1, { eventIndex: 0, deliveryOrdinal: 1, attemptNo: 2 })).toEqual({ kind: 'respond', status: 500 });
    expect(decideFault(plan, 1, { eventIndex: 0, deliveryOrdinal: 1, attemptNo: 3 })).toEqual({ kind: 'none' });
    expect(decideFault(plan, 2, { eventIndex: 0, deliveryOrdinal: 1, attemptNo: 1 })).toEqual({ kind: 'none' });
    expect(decideFault(plan, 1, { eventIndex: 1, deliveryOrdinal: 1, attemptNo: 1 })).toEqual({ kind: 'none' });
  });

  it('matches by delivery ordinal', () => {
    expect(decideFault(plan, 1, { eventIndex: 9, deliveryOrdinal: 2, attemptNo: 3 })).toEqual({ kind: 'sign_invalid' });
    expect(decideFault(plan, 1, { eventIndex: 9, deliveryOrdinal: 1, attemptNo: 3 })).toEqual({ kind: 'none' });
  });

  it('null plan means no fault', () => {
    expect(decideFault(null, 1, { eventIndex: 0, deliveryOrdinal: 1, attemptNo: 1 })).toEqual({ kind: 'none' });
  });

  it('random failures reproduce for the same seed and differ across seeds', () => {
    const mk = (seed: number): FaultPlan => ({ seed, rules: [], randomFailure: { rate: 0.5, status: 500 } });
    const trace = (p: FaultPlan) =>
      Array.from({ length: 200 }, (_, i) =>
        decideFault(p, 1, { eventIndex: i, deliveryOrdinal: 1, attemptNo: 1 }).kind === 'respond' ? 1 : 0,
      ).join('');
    expect(trace(mk(11))).toBe(trace(mk(11)));
    expect(trace(mk(11))).not.toBe(trace(mk(12)));
    const failures = [...trace(mk(11))].filter((c) => c === '1').length;
    expect(failures).toBeGreaterThan(70);
    expect(failures).toBeLessThan(130);
  });
});

describe('scenario blueprints', () => {
  it('same seed + config reproduce the same blueprint', () => {
    for (const t of SCENARIO_TYPES) {
      expect(buildBlueprint(t, 3, { eventCount: 2 })).toEqual(buildBlueprint(t, 3, { eventCount: 2 }));
    }
  });

  it('fail_twice fails attempts 1-2 only', () => {
    const bp = buildBlueprint('fail_twice', 1);
    const ctx = (attemptNo: number) => ({ eventIndex: 0, deliveryOrdinal: 1, attemptNo });
    expect(decideFault(bp.faultPlan, 1, ctx(1)).kind).toBe('respond');
    expect(decideFault(bp.faultPlan, 1, ctx(2)).kind).toBe('respond');
    expect(decideFault(bp.faultPlan, 1, ctx(3)).kind).toBe('none');
  });

  it('timeout_after_commit delays longer than the HTTP timeout on attempt 1 only', () => {
    const bp = buildBlueprint('timeout_after_commit', 1, { httpTimeoutMs: 800 });
    const a1 = decideFault(bp.faultPlan, 1, { eventIndex: 0, deliveryOrdinal: 1, attemptNo: 1 });
    expect(a1.kind === 'commit_then_delay' && a1.delayMs > 800).toBe(true);
    expect(decideFault(bp.faultPlan, 1, { eventIndex: 0, deliveryOrdinal: 1, attemptNo: 2 }).kind).toBe('none');
  });

  it('exhaust_and_replay fails in phase 1 and is healthy in phase 2', () => {
    const bp = buildBlueprint('exhaust_and_replay', 1);
    const ctx = { eventIndex: 0, deliveryOrdinal: 1, attemptNo: 1 };
    expect(decideFault(bp.faultPlan, 1, ctx).kind).toBe('respond');
    expect(decideFault(bp.faultPlan, 2, ctx).kind).toBe('none');
  });

  it('out_of_order sends sequences 3,1,2 one step at a time', () => {
    const bp = buildBlueprint('out_of_order', 1);
    const seqs = bp.steps.flatMap((s) => (s.kind === 'emit' ? s.events.map((e) => e.sequence) : []));
    expect(seqs).toEqual([3, 1, 2]);
    expect(bp.steps.filter((s) => s.kind === 'await_terminal')).toHaveLength(3);
  });

  it('duplicate_storm creates one event with N deliveries', () => {
    const bp = buildBlueprint('duplicate_storm', 1, { duplicateCount: 20 });
    const emit = bp.steps.find((s) => s.kind === 'emit');
    expect(emit && emit.kind === 'emit' && emit.events).toHaveLength(1);
    expect(emit && emit.kind === 'emit' && emit.events[0]!.deliveries).toBe(20);
  });

  it('rejects out-of-bounds config', () => {
    expect(() => resolveRunConfig({ eventCount: 101 }, 'healthy')).toThrow();
    expect(() => resolveRunConfig({ duplicateCount: 21 }, 'duplicate_storm')).toThrow();
    expect(() => resolveRunConfig({ httpTimeoutMs: 60_000 }, 'healthy')).toThrow();
    expect(() => resolveRunConfig({ nope: 1 } as never, 'healthy')).toThrow();
  });
});

describe('allowlist and redis url', () => {
  const allow = parseAllowlist('http://127.0.0.1:3100/webhooks/');
  it('accepts only the exact origin and path prefix', () => {
    expect(isUrlAllowed('http://127.0.0.1:3100/webhooks/receiver-fixture', allow)).toBe(true);
    expect(isUrlAllowed('http://127.0.0.1:3101/webhooks/x', allow)).toBe(false);
    expect(isUrlAllowed('https://127.0.0.1:3100/webhooks/x', allow)).toBe(false);
    expect(isUrlAllowed('http://evil.example/webhooks/x', allow)).toBe(false);
    expect(isUrlAllowed('http://127.0.0.1:3100/admin', allow)).toBe(false);
    expect(isUrlAllowed('http://user:pw@127.0.0.1:3100/webhooks/x', allow)).toBe(false);
    expect(isUrlAllowed('http://127.0.0.1:3100/webhooks/../admin', allow)).toBe(false);
    expect(isUrlAllowed('not a url', allow)).toBe(false);
  });

  it('parses redis urls', () => {
    expect(parseRedisUrl('redis://:pw@cache:6380/2')).toEqual({ host: 'cache', port: 6380, password: 'pw', db: 2 });
    expect(parseRedisUrl('redis://127.0.0.1')).toEqual({ host: '127.0.0.1', port: 6379 });
  });
});
