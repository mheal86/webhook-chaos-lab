import { createLogger, loadConfig } from '@lab/shared';
import { createReceiverApp } from './bootstrap';

async function main() {
  const config = loadConfig();
  const log = createLogger('receiver', config.LOG_LEVEL);
  const app = await createReceiverApp(config, { logger: log });
  await app.listen(config.RECEIVER_PORT, config.RECEIVER_HOST);
  log.info('receiver listening', { host: config.RECEIVER_HOST, port: config.RECEIVER_PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
