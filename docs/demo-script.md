# Demo script (about 10 minutes)

Goal: show that the system keeps business effects correct while delivery goes wrong.

## 0. Start the stack

With Docker:

```bash
docker compose up --build        # dashboard: http://127.0.0.1:8080
```

Without Docker (Windows/macOS/Linux, what the author uses):

```bash
pnpm install && pnpm build
pnpm infra:local                  # terminal 1: PostgreSQL :5440 + Redis :6390
cp .env.example .env              # then export the variables in your shell
pnpm db:migrate && pnpm db:seed
node apps/receiver/dist/main.js   # terminal 2
node apps/worker/dist/main.js     # terminal 3
node apps/api/dist/main.js        # terminal 4  (Swagger: http://127.0.0.1:3000/api/docs)
pnpm --filter @lab/web dev        # terminal 5  (dashboard: http://127.0.0.1:5173)
```

## 1. Healthy baseline (1 min)

Scenario Runner → **Healthy** → Run. Every assertion turns green: 1 attempt per delivery, effects
= events. Open the event: one delivery, one attempt, `200`.

Talking point: an event, a delivery and an attempt are three different things.

## 2. Fail twice then recover (1 min)

Run **Fail twice**. Open the delivery timeline: `500`, `500`, `200`, with the backoff delay between
attempts. Receiver Inspector shows 3 requests but only 1 business effect.

Talking point: PostgreSQL owns the retry schedule (`next_attempt_at`); BullMQ only wakes the worker.

## 3. Duplicate storm (1 min)

Run **Duplicate storm** (20 concurrent deliveries of the same event). Receiver: 20 requests,
1 `processed`, 19 `duplicate`.

Talking point: dedupe is a unique key in the same transaction as the effect, not a
SELECT-then-INSERT, so concurrency cannot double-apply.

## 4. Timeout after commit (1 min)

Run **Timeout after commit**. Attempt 1 shows **timeout — outcome unknown at sender** (not "receiver
failed"). The retry is answered as a duplicate. Still 1 effect.

Talking point: a timeout is not a failure; it is "we do not know". That is why receivers must be
idempotent.

## 5. Out of order (1 min)

Run **Out-of-order**. Receive order is `3,1,2`; the order projection stays at sequence 3 and two
stale snapshots are ignored.

## 6. Dead letter and replay (2 min)

Run **Exhaust retries and replay**, or open **Dead letters** after a run with dead deliveries.
Press **Replay**: a new delivery is created and linked to the original, which stays `dead` with
its full history.

## 7. Kill things (2 min, local stack)

Start a bounded load and kill the worker while it runs:

```bash
node scripts/load-test.mjs --events 300 --concurrency 10 &
# kill the worker process now (docker compose kill worker, or end the node process), wait ~5 s,
# then start it again (docker compose start worker / node apps/worker/dist/main.js)
```

Expected: the load test still ends with all deliveries `succeeded`; the delivery that was in flight
has a `worker_lost` attempt (written when its lease expired) followed by a successful attempt in
the next generation; business effects = events. A real run of exactly this is recorded in
[verification.md](verification.md#chaos-run-worker-killed-during-load).

Other things to kill: Redis (`docker compose stop redis`) — `POST /api/events` still returns 202 and
the events are dispatched once Redis is back; the receiver — deliveries go to `retry_wait` and
finish once it returns within the retry budget.
