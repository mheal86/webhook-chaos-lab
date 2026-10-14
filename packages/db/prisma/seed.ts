import { loadConfig } from '@lab/shared';
import { createDb, seedDatabase } from '../src';

async function main() {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL, { max: 2 });
  try {
    await seedDatabase(db, { receiverUrl: config.RECEIVER_URL });
    console.log('seed complete (idempotent)');
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
