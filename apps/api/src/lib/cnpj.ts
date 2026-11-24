/**
 * CNPJ numérico (00.000.000/0000-00) e ALFANUMÉRICO (emitido pela Receita desde
 * julho/2026: as 12 primeiras posições aceitam A–Z, os 2 dígitos verificadores
 * continuam numéricos).
 *
 * Cálculo dos dígitos (o mesmo para os dois formatos): cada caractere vale o seu
 * código ASCII − 48 ('0'–'9' → 0–9; 'A'–'Z' → 17–42), pesos 2..9 da direita para
 * a esquerda, DV = 11 − (soma mod 11), e 0 quando o resultado for 10 ou 11.
 */

const BODY = /^[0-9A-Z]{12}$/;

/** Remove máscara e espaços e põe em maiúsculas. Não valida. */
export function normalizeCnpj(input: string): string {
  return input.toUpperCase().replace(/[.\-/\s]/g, '');
}

function checkDigit(chars: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = chars.length - 1; i >= 0; i--) {
    sum += (chars.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

/** Calcula os 2 dígitos verificadores para as 12 primeiras posições. */
export function cnpjCheckDigits(body12: string): string {
  if (!BODY.test(body12)) throw new Error('as 12 primeiras posições devem ser 0–9 ou A–Z');
  const d1 = checkDigit(body12);
  const d2 = checkDigit(body12 + d1);
  return `${d1}${d2}`;
}

export function isValidCnpj(input: string): boolean {
  const v = normalizeCnpj(input);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(v)) return false;
  // Sequências repetidas (00000000000000, 11111111111111…) passam no cálculo mas não existem
  if (/^(.)\1{13}$/.test(v)) return false;
  return cnpjCheckDigits(v.slice(0, 12)) === v.slice(12);
}

/** 11222333000181 → 11.222.333/0001-81 (também para o alfanumérico). */
export function formatCnpj(v: string): string {
  const n = normalizeCnpj(v);
  if (n.length !== 14) return v;
  return `${n.slice(0, 2)}.${n.slice(2, 5)}.${n.slice(5, 8)}/${n.slice(8, 12)}-${n.slice(12)}`;
}
