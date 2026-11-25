import type { Config } from '../config.js';
import { FakeGateway, StripeGateway, type BillingGateway } from './gateway.js';
import { FakeProviders, LiveProviders, type MessagingProviders } from '../messaging/providers.js';

export function createGateway(config: Config): BillingGateway {
  if (config.BILLING_PROVIDER === 'stripe') return new StripeGateway(config.STRIPE_SECRET_KEY!);
  return new FakeGateway(config.APP_PUBLIC_URL);
}

export function createMessaging(config: Config): MessagingProviders {
  return config.MESSAGING_MODE === 'fake' ? new FakeProviders() : new LiveProviders(config.WHATSAPP_GRAPH_VERSION);
}
