// Smoke test for a running stack (docker compose or local): waits for readiness, then runs a few
// scenarios through the public API and fails unless every assertion passes.
//   node scripts/compose-smoke.mjs [baseUrl=http://127.0.0.1:8080] [scenario ...]
const base = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const scenarios = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ['healthy', 'fail_twice', 'duplicate_storm'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const res = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function waitReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await api('/health/ready');
      if (r.checks?.redis) return r;
      last = JSON.stringify(r);
    } catch (e) {
      last = String(e.message ?? e);
    }
    await sleep(2000);
  }
  throw new Error(`stack not ready after ${timeoutMs} ms: ${last}`);
}

async function runScenario(type) {
  const { runId } = await api(`/scenarios/${type}/runs`, {
    method: 'POST',
    body: JSON.stringify({ seed: 42 }),
  });
  const deadline = Date.now() + 120_000;
  let run = await api(`/runs/${runId}`);
  while ((run.status === 'running' || run.status === 'open') && Date.now() < deadline) {
    await sleep(1000);
    run = await api(`/runs/${runId}`);
  }
  return run;
}

console.log(`waiting for ${base} ...`);
console.log('ready:', JSON.stringify(await waitReady()));
let failed = 0;
for (const type of scenarios) {
  const run = await runScenario(type);
  console.log(`${type}: ${run.status}${run.failureReason ? ` (${run.failureReason})` : ''}`);
  for (const a of run.assertions) {
    console.log(
      `  ${a.status.padEnd(7)} ${a.key.padEnd(16)} actual=${a.actual} expected=${a.expectedValue}`,
    );
  }
  if (run.status !== 'passed') failed++;
}
if (failed) {
  console.error(`${failed} scenario(s) did not pass`);
  process.exit(1);
}
console.log('smoke test passed');
