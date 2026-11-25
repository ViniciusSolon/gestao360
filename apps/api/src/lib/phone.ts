/**
 * Telefone brasileiro → formato E.164 só com dígitos (55 + DDD + número), como
 * exigem a API do WhatsApp e a Zenvia. Devolve null se não der para garantir.
 *   "(11) 98888-0000" → "5511988880000"   "+55 11 3333-4444" → "551133334444"
 */
export function normalizeBrPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let d = input.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!/^55\d{10,11}$/.test(d)) return null;
  const ddd = Number(d.slice(2, 4));
  if (ddd < 11 || ddd > 99) return null;
  const local = d.slice(4);
  // celular tem 9 dígitos começando com 9; fixo tem 8 dígitos começando com 2–5
  if (local.length === 9 && local[0] !== '9') return null;
  if (local.length === 8 && !/^[2-5]/.test(local)) return null;
  return d;
}

export function isMobile(e164: string): boolean {
  return e164.length === 13 && e164[4] === '9';
}
