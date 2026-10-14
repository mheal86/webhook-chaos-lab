-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('queued', 'in_flight', 'retry_wait', 'succeeded', 'dead');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('in_progress', 'success', 'http_retryable', 'http_permanent', 'network_error', 'timeout', 'worker_lost');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('open', 'running', 'passed', 'failed');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'published');

-- CreateEnum
CREATE TYPE "ReceiverResult" AS ENUM ('received', 'processed', 'duplicate', 'stale', 'conflict', 'rejected_signature', 'rejected_bad_request', 'injected_failure', 'error');

-- CreateTable
CREATE TABLE "endpoints" (
    "id" TEXT NOT NULL,
    "consumer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret_ref" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_runs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL,
    "seed" INTEGER NOT NULL,
    "phase" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL,
    "fault_plan" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "step_index" INTEGER NOT NULL DEFAULT 0,
    "expected" JSONB NOT NULL,
    "result" JSONB,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "scenario_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "logical_index" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "raw_payload" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "replay_of_delivery_id" TEXT,
    "ordinal" INTEGER NOT NULL,
    "state" "DeliveryState" NOT NULL DEFAULT 'queued',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(3),
    "lease_until" TIMESTAMPTZ(3),
    "claim_token" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "terminal_reason" TEXT,
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "claim_token" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "outcome" "AttemptOutcome" NOT NULL DEFAULT 'in_progress',
    "http_status" INTEGER,
    "error_code" TEXT,
    "duration_ms" INTEGER,
    "response_preview" TEXT,
    "retry_after_applied" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_retry_at" TIMESTAMPTZ(3),
    "late_result" JSONB,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "available_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "published_at" TIMESTAMPTZ(3),
    "job_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receiver_requests" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "run_id" TEXT,
    "consumer_id" TEXT NOT NULL,
    "event_id" TEXT,
    "delivery_id" TEXT,
    "attempt_no" INTEGER,
    "event_sequence" INTEGER,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "result" "ReceiverResult" NOT NULL DEFAULT 'received',
    "http_status" INTEGER,
    "detail" TEXT,
    "signature_valid" BOOLEAN,
    "payload_hash" TEXT,

    CONSTRAINT "receiver_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "consumer_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "run_id" TEXT,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer_id","event_id")
);

-- CreateTable
CREATE TABLE "business_effects" (
    "id" TEXT NOT NULL,
    "run_id" TEXT,
    "consumer_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_effects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counter_projections" (
    "run_id" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "counter_projections_pkey" PRIMARY KEY ("run_id","aggregate_id")
);

-- CreateTable
CREATE TABLE "order_projections" (
    "run_id" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_projections_pkey" PRIMARY KEY ("run_id","aggregate_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "endpoints_consumer_id_key" ON "endpoints"("consumer_id");

-- CreateIndex
CREATE INDEX "scenario_runs_created_at_idx" ON "scenario_runs"("created_at");

-- CreateIndex
CREATE INDEX "scenario_runs_status_idx" ON "scenario_runs"("status");

-- CreateIndex
CREATE INDEX "events_run_id_logical_index_idx" ON "events"("run_id", "logical_index");

-- CreateIndex
CREATE INDEX "events_type_created_at_idx" ON "events"("type", "created_at");

-- CreateIndex
CREATE INDEX "events_created_at_idx" ON "events"("created_at");

-- CreateIndex
CREATE INDEX "deliveries_run_id_state_idx" ON "deliveries"("run_id", "state");

-- CreateIndex
CREATE INDEX "deliveries_event_id_idx" ON "deliveries"("event_id");

-- CreateIndex
CREATE INDEX "deliveries_state_next_attempt_at_idx" ON "deliveries"("state", "next_attempt_at");

-- CreateIndex
CREATE INDEX "deliveries_replay_of_delivery_id_idx" ON "deliveries"("replay_of_delivery_id");

-- CreateIndex
CREATE INDEX "deliveries_created_at_idx" ON "deliveries"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_event_id_endpoint_id_ordinal_key" ON "deliveries"("event_id", "endpoint_id", "ordinal");

-- CreateIndex
CREATE INDEX "delivery_attempts_run_id_started_at_idx" ON "delivery_attempts"("run_id", "started_at");

-- CreateIndex
CREATE INDEX "delivery_attempts_outcome_idx" ON "delivery_attempts"("outcome");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_delivery_id_attempt_no_key" ON "delivery_attempts"("delivery_id", "attempt_no");

-- CreateIndex
CREATE INDEX "outbox_status_available_at_idx" ON "outbox"("status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_delivery_id_generation_key" ON "outbox"("delivery_id", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "receiver_requests_seq_key" ON "receiver_requests"("seq");

-- CreateIndex
CREATE INDEX "receiver_requests_run_id_seq_idx" ON "receiver_requests"("run_id", "seq");

-- CreateIndex
CREATE INDEX "receiver_requests_event_id_idx" ON "receiver_requests"("event_id");

-- CreateIndex
CREATE INDEX "receiver_requests_result_idx" ON "receiver_requests"("result");

-- CreateIndex
CREATE INDEX "processed_events_run_id_idx" ON "processed_events"("run_id");

-- CreateIndex
CREATE INDEX "business_effects_run_id_idx" ON "business_effects"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_effects_consumer_id_event_id_key" ON "business_effects"("consumer_id", "event_id");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "scenario_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "scenario_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_replay_of_delivery_id_fkey" FOREIGN KEY ("replay_of_delivery_id") REFERENCES "deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written additions (not expressible in schema.prisma)
-- ---------------------------------------------------------------------------

-- At most one active (running) scenario run at a time. The API maps the violation to HTTP 409.
CREATE UNIQUE INDEX "one_running_scenario_run" ON "scenario_runs" ((true)) WHERE "status" = 'running';

-- Work-queue style partial indexes for the hot polling queries.
CREATE INDEX "outbox_pending_available_idx" ON "outbox" ("available_at") WHERE "status" = 'pending';
CREATE INDEX "outbox_published_idx" ON "outbox" ("published_at") WHERE "status" = 'published';
CREATE INDEX "deliveries_due_idx" ON "deliveries" ("next_attempt_at") WHERE "state" IN ('queued', 'retry_wait');
CREATE INDEX "deliveries_lease_idx" ON "deliveries" ("lease_until") WHERE "state" = 'in_flight';

-- Invariants enforced by the database.
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_attempt_budget_chk" CHECK ("attempt_count" >= 0 AND "attempt_count" <= "max_attempts");
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_in_flight_claim_chk" CHECK ("state" <> 'in_flight' OR ("claim_token" IS NOT NULL AND "lease_until" IS NOT NULL));
ALTER TABLE "events" ADD CONSTRAINT "events_payload_size_chk" CHECK (octet_length("raw_payload") <= 65536);
