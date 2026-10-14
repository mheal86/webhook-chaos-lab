import { DEFAULT_RUN_CONFIG, SEED } from '@lab/shared';
import type { Db } from './client';

export interface SeedOptions {
  receiverUrl: string;
  secretRef?: string;
}

/** Idempotent: safe to run on every start. */
export async function seedDatabase(db: Db, options: SeedOptions): Promise<void> {
  await db.endpoint.upsert({
    where: { id: SEED.endpointId },
    create: {
      id: SEED.endpointId,
      consumerId: SEED.consumerId,
      name: 'Receiver fixture',
      url: options.receiverUrl,
      secretRef: options.secretRef ?? 'RECEIVER_SECRET',
      enabled: true,
    },
    update: { url: options.receiverUrl, secretRef: options.secretRef ?? 'RECEIVER_SECRET' },
  });

  // Singleton "manual" run: home of events created through POST /api/events without a runId.
  await db.scenarioRun.upsert({
    where: { id: SEED.manualRunId },
    create: {
      id: SEED.manualRunId,
      type: 'manual',
      status: 'open',
      seed: 0,
      phase: 1,
      config: DEFAULT_RUN_CONFIG as never,
      faultPlan: { seed: 0, rules: [] },
      steps: [],
      expected: [],
    },
    update: {},
  });
}
