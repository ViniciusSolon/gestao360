import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cofre de segredos dos canais das empresas (tokens de Resend/Meta/Zenvia).
 * AES-256-GCM com a chave CHANNEL_SECRETS_KEY (64 hex), que fica fora do banco.
 * Sem a chave, um vazamento do banco não expõe os tokens dos clientes.
 */
export function sealSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

export function openSecret(sealed: string, keyHex: string): string {
  const [v, data] = sealed.split(':');
  if (v !== 'v1' || !data) throw new Error('formato de segredo desconhecido');
  const raw = Buffer.from(data, 'base64');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export function secretHint(plain: string): string {
  return plain.length <= 4 ? '••••' : `••••${plain.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Link de descadastro assinado (a pessoa não tem login)
// ---------------------------------------------------------------------------
export interface OptOutClaim {
  t: string; // tenant
  c: 'email' | 'whatsapp' | 'sms';
  a: string; // endereço
}

function mac(keyHex: string, payload: string) {
  // chave derivada só para este uso (não reaproveita a chave de cifra diretamente)
  const k = createHmac('sha256', Buffer.from(keyHex, 'hex')).update('optout-v1').digest();
  return createHmac('sha256', k).update(payload).digest().subarray(0, 16);
}

export function signOptOut(claim: OptOutClaim, keyHex: string): string {
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  return `${payload}.${mac(keyHex, payload).toString('base64url')}`;
}

export function verifyOptOut(token: string, keyHex: string): OptOutClaim | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = mac(keyHex, payload);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof c.t !== 'string' || !['email', 'whatsapp', 'sms'].includes(c.c) || typeof c.a !== 'string') return null;
    return c;
  } catch {
    return null;
  }
}
