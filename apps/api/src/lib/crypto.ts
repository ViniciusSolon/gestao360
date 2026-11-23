import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(pw: string, salt: Buffer, len: number, opts: typeof PARAMS): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Hash fixo usado para gastar o mesmo tempo quando o e-mail não existe (evita enumeração por tempo)
const DUMMY = `scrypt$16384$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [alg, n, saltB64, keyB64] = (stored ?? DUMMY).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { ...PARAMS, N: Number(n) });
  return stored !== null && timingSafeEqual(key, expected);
}

/** Token opaco para cookie/convite. Só o hash vai para o banco. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(v: string | Buffer): string {
  return createHash('sha256').update(v).digest('hex');
}
