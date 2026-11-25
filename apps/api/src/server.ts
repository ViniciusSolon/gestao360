import { loadConfig } from './config.js';
import { Db } from './db/db.js';
import { buildApp } from './app.js';
import { createGateway, createMessaging } from './billing/factory.js';
import { ConsoleEmailSender } from './email/email.js';
import { startWorkerLoop } from './jobs/runner.js';

const config = loadConfig();
const db = new Db(config.DATABASE_APP_URL, config.DATABASE_PLATFORM_URL, config.DB_POOL_MAX);
const deps = { config, db, gateway: createGateway(config), email: new ConsoleEmailSender(), messaging: createMessaging(config) };
const app = await buildApp(deps);
const stopWorker = config.WORKER_INLINE ? startWorkerLoop(deps) : null;

await app.listen({ port: config.PORT, host: config.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopWorker?.();
    await app.close();
    await db.close();
    process.exit(0);
  });
}
