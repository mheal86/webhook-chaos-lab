import { createLogger, loadConfig } from '@lab/shared';
import { createWorkerApp } from './bootstrap';

async function main() {
  const config = loadConfig();
  const log = createLogger('worker', config.LOG_LEVEL);
  await createWorkerApp(config, { logger: log });
  log.info('worker started', { pid: process.pid });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
