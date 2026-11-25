import type { Config } from './config.js';
import type { Db } from './db/db.js';
import type { BillingGateway } from './billing/gateway.js';
import type { EmailSender } from './email/email.js';
import type { MessagingProviders } from './messaging/providers.js';

/** Dependências injetadas (facilita trocar serviços externos nos testes). */
export interface Deps {
  config: Config;
  db: Db;
  gateway: BillingGateway;
  email: EmailSender;
  /** Envio das campanhas (contas de cada empresa) */
  messaging: MessagingProviders;
}
