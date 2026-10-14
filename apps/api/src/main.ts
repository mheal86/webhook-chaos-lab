import { createLogger, loadConfig } from '@lab/shared';
import { createApiApp } from './bootstrap';

async function main() {
  const config = loadConfig();
  const log = createLogger('api', config.LOG_LEVEL);
  const app = await createApiApp(config, { logger: log });
  await app.listen(config.API_PORT, config.API_HOST);
  log.info('api listening', { host: config.API_HOST, port: config.API_PORT, docs: '/api/docs' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
