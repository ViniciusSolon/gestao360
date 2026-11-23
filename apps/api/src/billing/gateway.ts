import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Abstração do gateway de pagamento. A implementação Stripe fala com a API real;
 * a Fake é usada em desenvolvimento e nos testes (é o único "mock" permitido:
 * serviço externo).
 */
export interface CheckoutInput {
  tenantId: string;
  planCode: string;
  gatewayPriceId: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface GatewaySubscription {
  id: string;
  status: string; // active | trialing | past_due | unpaid | canceled | incomplete | incomplete_expired
  tenantId: string;
  planCode: string;
  currentPeriodEnd: Date | null;
}

export interface BillingGateway {
  readonly provider: string;
  createCheckoutSession(input: CheckoutInput, idempotencyKey: string): Promise<{ id: string; url: string }>;
  retrieveSubscription(id: string): Promise<GatewaySubscription>;
}

// ---------------------------------------------------------------------------
// Assinatura de webhook (esquema compatível com Stripe: t=<ts>,v1=<hmac>)
// ---------------------------------------------------------------------------
export const SIGNATURE_TOLERANCE_S = 300;

export function signPayload(secret: string, rawBody: Buffer | string, ts = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex');
  return `t=${ts},v1=${mac}`;
}

export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined, nowS = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const ts = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(ts) || sigs.length === 0) return false;
  if (Math.abs(nowS - ts) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// ---------------------------------------------------------------------------
// Stripe (HTTP direto, sem SDK)
// ---------------------------------------------------------------------------
export class StripeGateway implements BillingGateway {
  readonly provider = 'stripe';
  constructor(private readonly secretKey: string) {}

  private async call(method: string, path: string, body?: URLSearchParams, idempotencyKey?: string) {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body,
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message ?? 'erro'}`);
    return json;
  }

  async createCheckoutSession(input: CheckoutInput, idempotencyKey: string) {
    if (!input.gatewayPriceId) throw new Error(`Plano ${input.planCode} sem gateway_price_id`);
    const body = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': input.gatewayPriceId,
      'line_items[0][quantity]': '1',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.tenantId,
      'subscription_data[metadata][tenant_id]': input.tenantId,
      'subscription_data[metadata][plan_code]': input.planCode,
    });
    const s = await this.call('POST', '/checkout/sessions', body, idempotencyKey);
    return { id: s.id as string, url: s.url as string };
  }

  async retrieveSubscription(id: string): Promise<GatewaySubscription> {
    const s = await this.call('GET', `/subscriptions/${encodeURIComponent(id)}`);
    return {
      id: s.id,
      status: s.status,
      tenantId: s.metadata?.tenant_id,
      planCode: s.metadata?.plan_code,
      currentPeriodEnd: s.current_period_end ? new Date(s.current_period_end * 1000) : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Fake (dev/testes): em memória, respeita Idempotency-Key como a Stripe
// ---------------------------------------------------------------------------
export class FakeGateway implements BillingGateway {
  readonly provider = 'fake';
  readonly checkoutCalls: { key: string; input: CheckoutInput }[] = [];
  private sessionsByKey = new Map<string, { id: string; url: string; input: CheckoutInput }>();
  private sessions = new Map<string, { id: string; url: string; input: CheckoutInput }>();
  readonly subscriptions = new Map<string, GatewaySubscription>();
  retrieveCalls = 0;

  constructor(private readonly publicUrl = 'http://localhost:5173') {}

  async createCheckoutSession(input: CheckoutInput, idempotencyKey: string) {
    this.checkoutCalls.push({ key: idempotencyKey, input });
    const existing = this.sessionsByKey.get(idempotencyKey);
    if (existing) return { id: existing.id, url: existing.url };
    const id = `cs_fake_${randomUUID()}`;
    const s = { id, url: `${this.publicUrl}/app/assinatura/checkout-fake?session=${id}`, input };
    this.sessionsByKey.set(idempotencyKey, s);
    this.sessions.set(id, s);
    return { id, url: s.url };
  }

  async retrieveSubscription(id: string) {
    this.retrieveCalls++;
    const s = this.subscriptions.get(id);
    if (!s) throw new Error(`assinatura ${id} não existe`);
    return { ...s };
  }

  /** Simula o pagamento do checkout: cria a assinatura e devolve o evento de webhook. */
  completeCheckout(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('sessão de checkout inexistente');
    const subId = `sub_fake_${sessionId.slice(-12)}`;
    this.subscriptions.set(subId, {
      id: subId,
      status: 'active',
      tenantId: s.input.tenantId,
      planCode: s.input.planCode,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    return {
      id: `evt_${randomUUID()}`,
      type: 'checkout.session.completed',
      data: { object: { id: sessionId, subscription: subId, client_reference_id: s.input.tenantId } },
    };
  }

  setSubscriptionStatus(subId: string, status: string) {
    const s = this.subscriptions.get(subId);
    if (!s) throw new Error('assinatura inexistente');
    s.status = status;
    return {
      id: `evt_${randomUUID()}`,
      type: 'customer.subscription.updated',
      data: { object: { id: subId, status } },
    };
  }
}
