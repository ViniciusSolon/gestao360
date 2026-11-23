import type { Config } from '../config.js';
import { FakeGateway, StripeGateway, type BillingGateway } from './gateway.js';

export function createGateway(config: Config): BillingGateway {
  if (config.BILLING_PROVIDER === 'stripe') return new StripeGateway(config.STRIPE_SECRET_KEY!);
  return new FakeGateway(config.APP_PUBLIC_URL);
}
