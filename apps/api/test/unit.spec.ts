import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { assertDiscountAllowed, priceItem, scoreLead, sumTotals } from '../src/lib/pricing.js';
import { signPayload, verifySignature } from '../src/billing/gateway.js';
import { escapeHtml } from '../src/lib/html.js';
import { tenantStatusFor } from '../src/billing/sync.js';

const base = { DATABASE_APP_URL: 'postgres://a@h/db', DATABASE_PLATFORM_URL: 'postgres://b@h/db' };

describe('Configuração de startup', () => {
  it('quando falta o segredo do webhook, então não sobe', () => {
    expect(() => loadConfig({ ...base })).toThrow(/BILLING_WEBHOOK_SECRET/);
  });
  it('quando o segredo é fraco/padrão ou curto, então não sobe', () => {
    for (const s of ['changeme', 'secret', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'curto']) {
      expect(() => loadConfig({ ...base, BILLING_WEBHOOK_SECRET: s }), s).toThrow();
    }
  });
  it('quando é produção com gateway fake ou cookie inseguro, então não sobe', () => {
    const ok = { ...base, BILLING_WEBHOOK_SECRET: 'whsec_' + 'k'.repeat(10) + 'abcdefghijklmnop' };
    expect(() => loadConfig({ ...ok, NODE_ENV: 'production' })).toThrow(/fake/);
    expect(() => loadConfig({ ...ok, NODE_ENV: 'production', BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_live_x', COOKIE_SECURE: 'false' })).toThrow(/Secure/);
    expect(loadConfig({ ...ok, NODE_ENV: 'production', BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_live_x' }).cookieSecure).toBe(true);
  });
});

describe('Regras de preço', () => {
  const p = { id: 'p', name: 'P', priceCents: 1999, taxRateBp: 1800 };
  it('calcula item com quantidade fracionada e arredondamento half-up', () => {
    const it1 = priceItem(p, { productId: 'p', quantity: 1.5, discountBp: 500 });
    expect(it1.grossCents).toBe(2999); // 29,985 → 29,99
    expect(it1.discountCents).toBe(150);
    expect(it1.taxCents).toBe(513);
    expect(it1.totalCents).toBe(2999 - 150 + 513);
  });
  it('soma totais e rejeita frete negativo', () => {
    const items = [priceItem(p, { productId: 'p', quantity: 2, discountBp: 0 })];
    expect(sumTotals(items, 100).totalCents).toBe(3998 + 720 + 100);
    expect(() => sumTotals(items, -1)).toThrow();
  });
  it('limita desconto por papel', () => {
    expect(() => assertDiscountAllowed('seller', 1001)).toThrow();
    expect(() => assertDiscountAllowed('seller', 1000)).not.toThrow();
    expect(() => assertDiscountAllowed('owner', 3001)).toThrow();
    expect(() => assertDiscountAllowed('owner', -1)).toThrow();
  });
  it('pontua lead entre 0 e 100', () => {
    expect(scoreLead({})).toBe(0);
    expect(scoreLead({ email: 'a', phone: 'b', company: 'c', valueCents: 1e9, channel: 'indicacao' })).toBe(100);
  });
});

describe('Assinatura de webhook', () => {
  const secret = 'whsec_' + 'z'.repeat(30);
  it('aceita assinatura válida e recusa corpo alterado, segredo errado e timestamp velho', () => {
    const body = Buffer.from('{"id":"evt"}');
    expect(verifySignature(secret, body, signPayload(secret, body))).toBe(true);
    expect(verifySignature(secret, Buffer.from('{"id":"evx"}'), signPayload(secret, body))).toBe(false);
    expect(verifySignature('outro' + secret, body, signPayload(secret, body))).toBe(false);
    expect(verifySignature(secret, body, signPayload(secret, body, 1000))).toBe(false);
    expect(verifySignature(secret, body, undefined)).toBe(false);
  });
});

describe('Diversos', () => {
  it('escapa HTML', () => expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;'));
  it('mapeia status do gateway', () => {
    expect(tenantStatusFor('active')).toBe('active');
    expect(tenantStatusFor('unpaid')).toBe('past_due');
    expect(tenantStatusFor('canceled')).toBe('canceled');
    expect(tenantStatusFor('incomplete')).toBeNull();
  });
});
