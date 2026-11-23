/**
 * Regras de preço das propostas. Rodam SOMENTE no servidor: o cliente manda
 * produto, quantidade e desconto desejado; preço e tributo vêm do banco.
 */
import type { Role } from '../auth/roles.js';
import { forbidden, unprocessable } from './errors.js';

/** Desconto máximo por item (em basis points: 1000 = 10%) por papel. */
export const MAX_DISCOUNT_BP: Record<Role, number> = {
  seller: 1000,
  manager: 2000,
  admin: 3000,
  owner: 3000,
};

export const MAX_FREIGHT_CENTS = 10_000_000_00; // R$ 10 milhões
export const MAX_QUANTITY = 1_000_000;

export interface PricedProduct {
  id: string;
  name: string;
  priceCents: number;
  taxRateBp: number;
}

export interface ItemInput {
  productId: string;
  quantity: number;
  discountBp: number;
}

export interface PricedItem {
  productId: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountBp: number;
  taxRateBp: number;
  grossCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

export interface Totals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  freightCents: number;
  totalCents: number;
}

/** Arredondamento half-up em BigInt: (a * b) / d */
function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b * 2n + d) / (2n * d);
}

export function priceItem(product: PricedProduct, input: ItemInput): PricedItem {
  if (!(input.quantity > 0) || input.quantity > MAX_QUANTITY) throw unprocessable('Quantidade inválida', 'invalid_quantity');
  const qtyMilli = BigInt(Math.round(input.quantity * 1000));
  if (qtyMilli <= 0n) throw unprocessable('Quantidade inválida', 'invalid_quantity');
  const unit = BigInt(product.priceCents);
  const gross = mulDiv(unit, qtyMilli, 1000n);
  const discount = mulDiv(gross, BigInt(input.discountBp), 10000n);
  const net = gross - discount;
  const tax = mulDiv(net, BigInt(product.taxRateBp), 10000n);
  return {
    productId: product.id,
    description: product.name,
    quantity: Number(qtyMilli) / 1000,
    unitPriceCents: product.priceCents,
    discountBp: input.discountBp,
    taxRateBp: product.taxRateBp,
    grossCents: Number(gross),
    discountCents: Number(discount),
    taxCents: Number(tax),
    totalCents: Number(net + tax),
  };
}

export function assertDiscountAllowed(role: Role, discountBp: number) {
  if (!Number.isInteger(discountBp) || discountBp < 0 || discountBp > 10000) {
    throw unprocessable('Desconto inválido', 'invalid_discount');
  }
  if (discountBp > MAX_DISCOUNT_BP[role]) {
    throw forbidden(`Desconto acima do permitido para o seu papel (máx. ${MAX_DISCOUNT_BP[role] / 100}%)`);
  }
}

export function sumTotals(items: PricedItem[], freightCents: number): Totals {
  if (!Number.isInteger(freightCents) || freightCents < 0 || freightCents > MAX_FREIGHT_CENTS) {
    throw unprocessable('Frete inválido', 'invalid_freight');
  }
  const subtotal = items.reduce((s, i) => s + i.grossCents, 0);
  const discount = items.reduce((s, i) => s + i.discountCents, 0);
  const tax = items.reduce((s, i) => s + i.taxCents, 0);
  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    freightCents,
    totalCents: subtotal - discount + tax + freightCents,
  };
}

/** Pontuação simples de lead (0–100) — regra de negócio do servidor. */
export function scoreLead(l: {
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  valueCents?: number | null;
  channel?: string | null;
}): number {
  let s = 0;
  if (l.email) s += 15;
  if (l.phone) s += 15;
  if (l.company) s += 20;
  const v = l.valueCents ?? 0;
  if (v >= 50_000_00) s += 30;
  else if (v >= 10_000_00) s += 20;
  else if (v > 0) s += 10;
  if (l.channel === 'indicacao') s += 20;
  else if (l.channel === 'site' || l.channel === 'evento') s += 10;
  return Math.min(100, s);
}

export const MQL_THRESHOLD = 50;
