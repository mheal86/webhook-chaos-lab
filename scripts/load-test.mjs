// Bounded load test against a running stack. Sends N `demo.counter.increment` events through
// POST /api/events with a fixed client concurrency, waits until every delivery is terminal, then
// reports numbers taken from the API's own timestamps. It never runs unbounded.
//   node scripts/load-test.mjs [--api http://127.0.0.1:3000] [--events 200] [--concurrency 10]
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const api = (args.api ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const total = Math.min(Number(args.events ?? 200), 2000);
const concurrency = Math.min(Number(args.concurrency ?? 10), 50);
const timeoutMs = Number(args.timeout ?? 300_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, init) {
  const res = await fetch(`${api}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const tag = `load-${Date.now().toString(36)}`;
console.log(`load test: ${total} events, client concurrency ${concurrency}, api ${api}`);
await call('/health/ready');

const t0 = performance.now();
const accepted = await pool(
  Array.from({ length: total }, (_, i) => i),
  concurrency,
  async (i) => {
    const s = performance.now();
    const body = await call('/events', {
      method: 'POST',
      body: JSON.stringify({
        type: 'demo.counter.increment',
        aggregateId: `${tag}-${i}`,
        sequence: 1,
        data: { delta: 1 },
      }),
    });
    return { eventId: body.eventId, acceptMs: performance.now() - s };
  },
);
const ingestSeconds = (performance.now() - t0) / 1000;

const details = new Map();
let pending = accepted.map((a) => a.eventId);
const deadline = Date.now() + timeoutMs;
while (pending.length && Date.now() < deadline) {
  await sleep(500);
  const polled = await pool(pending, concurrency, (id) => call(`/events/${id}`));
  for (const ev of polled) {
    if (ev.deliveries.every((d) => d.state === 'succeeded' || d.state === 'dead'))
      details.set(ev.id, ev);
  }
  pending = pending.filter((id) => !details.has(id));
}
const wallSeconds = (performance.now() - t0) / 1000;

const deliveries = [...details.values()].flatMap((e) => e.deliveries);
const succeeded = deliveries.filter((d) => d.state === 'succeeded');
const endToEnd = succeeded.map((d) => Date.parse(d.finishedAt) - Date.parse(d.createdAt));
const attempts = deliveries.flatMap((d) => d.attempts);
const attemptMs = attempts.map((a) => a.durationMs).filter((v) => typeof v === 'number');
const firstFinish = Math.min(...succeeded.map((d) => Date.parse(d.createdAt)));
const lastFinish = Math.max(...succeeded.map((d) => Date.parse(d.finishedAt)));
const r = (v) => (v === null ? 'n/a' : Math.round(v));

const report = {
  events: total,
  clientConcurrency: concurrency,
  timedOut: pending.length,
  deliveries: deliveries.length,
  succeeded: succeeded.length,
  dead: deliveries.filter((d) => d.state === 'dead').length,
  attempts: attempts.length,
  acceptLatencyMs: {
    p50: r(
      pct(
        accepted.map((a) => a.acceptMs),
        50,
      ),
    ),
    p95: r(
      pct(
        accepted.map((a) => a.acceptMs),
        95,
      ),
    ),
  },
  endToEndMs: { p50: r(pct(endToEnd, 50)), p95: r(pct(endToEnd, 95)), max: r(pct(endToEnd, 100)) },
  attemptDurationMs: { p50: r(pct(attemptMs, 50)), p95: r(pct(attemptMs, 95)) },
  ingestPerSecond: Math.round(total / ingestSeconds),
  deliveredPerSecond: succeeded.length
    ? Math.round(succeeded.length / ((lastFinish - firstFinish) / 1000))
    : 0,
  wallSeconds: Number(wallSeconds.toFixed(2)),
};
console.log(JSON.stringify(report, null, 2));
if (report.timedOut || report.dead) process.exit(1);
