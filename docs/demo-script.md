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

One command per failure; each builds its own isolated stack, so it does not disturb the demo:

```bash
pnpm chaos worker       # SIGKILL the worker mid-load
pnpm chaos receiver     # SIGKILL the receiver mid-load
pnpm chaos redis        # SIGKILL Redis, restart on its data
pnpm chaos redis-loss   # SIGKILL Redis, restart EMPTY
```

Each prints the counts from PostgreSQL and ends with `PASS: nothing lost, nothing applied twice`.

Talking points:

- `worker`: requests that reached the receiver right before the crash show up as `worker_lost`
  attempts (unknown at sender); their retries are answered as duplicates, so receiver requests >
  events but effects = events.
- `receiver`: deliveries fail with `network_error`, wait in `retry_wait`, and finish when it is back.
- `redis-loss`: the queue forgets everything; PostgreSQL does not, and the recovery loop re-issues
  the work.

Real results: [verification.md](verification.md#scripted-chaos-runs-scriptschaosmjs). With
Docker you can do the same by hand: `docker compose kill worker`, wait, `docker compose start worker`.
