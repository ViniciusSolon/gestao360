/** Worker dedicado (escala horizontalmente: N réplicas, SKIP LOCKED evita disputa). */
import { loadConfig } from './config.js';
import { Db } from './db/db.js';
import { createGateway, createMessaging } from './billing/factory.js';
import { ConsoleEmailSender } from './email/email.js';
import { startWorkerLoop } from './jobs/runner.js';

const config = loadConfig();
if (!config.DATABASE_PLATFORM_URL) throw new Error('O worker precisa de DATABASE_PLATFORM_URL');
const db = new Db(config.DATABASE_APP_URL, config.DATABASE_PLATFORM_URL, 4);
const stop = startWorkerLoop({ config, db, gateway: createGateway(config), email: new ConsoleEmailSender(), messaging: createMessaging(config) });
console.log('[worker] iniciado');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stop();
    await db.close();
    process.exit(0);
  });
}
