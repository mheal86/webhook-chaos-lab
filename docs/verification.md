# Verification

What was actually run, where, and with what result. Anything not run is listed as **not run**.
Last updated: 2026-10-18.

## Environment

- Windows 11 Home, Intel i5-12450HX (12 threads), 12 GB RAM, Node.js 22.18.0, pnpm 10.34.7.
- No Docker on this machine. PostgreSQL 18 comes from `embedded-postgres` and Redis 8.10 from a
  portable Windows build, both started by `pnpm infra:local` (`scripts/local-infra.mjs`).
- Playwright Chromium installed under `.tools/browsers` (picked up by `apps/web/playwright.config.ts`).

## Results on this machine (2026-10-18)

| Check             | Command                                                | Result                                                                             |
| ----------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Lint              | `pnpm lint`                                            | pass, 0 problems                                                                   |
| Formatting        | `pnpm format:check`                                    | pass                                                                               |
| Typecheck         | `pnpm typecheck`                                       | pass (all 7 workspace packages)                                                    |
| Build             | `pnpm build`                                           | pass                                                                               |
| Unit tests        | `pnpm test:unit`                                       | **80 / 80 passed** (3 suites, `@lab/shared`)                                       |
| Integration tests | `pnpm test:integration`                                | **77 / 77 passed** (4 suites, 30 s) against real PostgreSQL + Redis                |
| E2E               | `pnpm e2e`                                             | **7 / 7 passed** (34 s) in Chromium against the full stack                         |
| Smoke             | `node scripts/compose-smoke.mjs http://127.0.0.1:3000` | healthy, fail_twice, duplicate_storm all `passed` (local native stack, not Docker) |

Integration suites: `receiver.int.spec.ts` (signature, idempotency race with 20 concurrent
requests, payload conflict, rollback after marker insert), `engine.int.spec.ts` (claim, fencing,
state machine, replay), `pipeline.int.spec.ts` (all 7 scenarios end to end),
`recovery.int.spec.ts` (crash after commit before enqueue, Redis down, Redis queue state lost,
receiver restart, worker SIGKILL after receiver commit, job re-run after terminal, concurrent claim).

E2E specs (`apps/web/e2e/dashboard.spec.ts`): healthy run, retry timeline (500, 500, 200), timeout
shown as unknown at sender, dead letter → replay, exhaust and replay, out-of-order projection,
event filter and keyboard navigation.

## Load test (`scripts/load-test.mjs`)

Native local stack, default config (`WORKER_CONCURRENCY=4`, `DISPATCH_POLL_MS=250`), receiver
fixture answering `200`. Numbers come from the API's own timestamps (`delivery.createdAt` →
`delivery.finishedAt`) and client-side timing of `POST /api/events`.

| Run | Events / client concurrency | Succeeded | Dead | Attempts | Accept p50 / p95 | Accept → delivered p50 / p95 / max | Ingest | Delivered |
| --- | --------------------------- | --------- | ---- | -------- | ---------------- | ---------------------------------- | ------ | --------- |
| 1   | 200 / 10                    | 200       | 0    | 200      | 51 / 103 ms      | 327 / 363 / 371 ms                 | 169 /s | 138 /s    |
| 2   | 1000 / 20                   | 1000      | 0    | 1000     | 94 / 108 ms      | 345 / 370 / 380 ms                 | 214 /s | 204 /s    |

Database check after the runs (SQL over `events`, `business_effects`, `receiver_requests`):
200 events → 200 effects → 200 receiver requests; 1000 → 1000 → 1000.

These are single-machine dev numbers, not a production benchmark. End-to-end latency is dominated
by the dispatcher poll interval.

## Chaos run: worker killed during load

1. `node scripts/load-test.mjs --events 300 --concurrency 10` started.
2. 1 s later the worker process was force-killed (`Stop-Process -Force`, 01:50:22).
3. 7 s later a new worker was started (01:50:29).

Result: 300 / 300 succeeded, 0 dead, **301 attempts**. The one extra attempt belongs to the
delivery that was in flight when the worker died:

| attempt | generation | outcome       | started → finished (UTC)                                                        |
| ------- | ---------- | ------------- | ------------------------------------------------------------------------------- |
| 1       | 1          | `worker_lost` | 18:50:22.196 → 18:50:37.676 (lease of 15 s expired, recovery wrote the outcome) |
| 2       | 2          | `success`     | 18:50:38.803 → 18:50:38.904                                                     |

That delivery took 31 s end to end (the max in that run; p95 stayed at 334 ms). Database check:
300 events → 300 business effects → 300 receiver requests, so no event was lost or applied twice.

## Not run on this machine

| Item                                                           | Why                                | Where it is verified instead                                                                                           |
| -------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `docker compose up --build`, `Dockerfile`, `docker/nginx.conf` | Docker is not installed here       | `compose` job in `.github/workflows/ci.yml` (build images, start stack, run `scripts/compose-smoke.mjs` through nginx) |
| CI workflow itself                                             | runs on GitHub only                | GitHub Actions run on push to `main`                                                                                   |
| Killing Redis / receiver by hand during load                   | covered by automated tests instead | `recovery.int.spec.ts` (Redis down, Redis state lost, receiver restart)                                                |

CI status is recorded below once a run has completed.

## CI runs

_No completed run recorded yet._
