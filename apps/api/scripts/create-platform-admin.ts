/**
 * Cria (ou recria) um administrador da plataforma COM MFA obrigatório.
 *   PLATFORM_ADMIN_PASSWORD='...' npm -w apps/api run platform:create-admin -- email@empresa.com "Nome" superadmin
 *
 * Exige DATABASE_PLATFORM_URL e PLATFORM_MFA_KEY. Imprime UMA vez o link otpauth://
 * (cadastre no app autenticador) e os códigos de recuperação. Rodar de novo para o
 * mesmo e-mail troca senha, segredo TOTP e códigos, e derruba as sessões abertas.
 */
import pg from 'pg';
import { provisionPlatformAdmin } from '../src/lib/platform-admin.js';
import { base32Encode } from '../src/lib/totp.js';

const [email, name, role = 'support'] = process.argv.slice(2);
const password = process.env.PLATFORM_ADMIN_PASSWORD;
const url = process.env.DATABASE_PLATFORM_URL;
const mfaKey = process.env.PLATFORM_MFA_KEY;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!email || !name || (role !== 'superadmin' && role !== 'support')) fail('uso: create-platform-admin <email> <nome> [superadmin|support]');
if (!password || password.length < 14) fail('Defina PLATFORM_ADMIN_PASSWORD (mínimo 14 caracteres).');
if (!url) fail('Defina DATABASE_PLATFORM_URL.');
if (!mfaKey || !/^[0-9a-fA-F]{64}$/.test(mfaKey)) fail('Defina PLATFORM_MFA_KEY (64 hex: openssl rand -hex 32).');

const pool = new pg.Pool({ connectionString: url, max: 1 });
const r = await provisionPlatformAdmin(pool, { email, name, role, password }, mfaKey);
await pool.end();

console.log(`\nAdmin da plataforma ${email} (${role}) pronto. MFA obrigatório.\n`);
console.log('1) Cadastre no app autenticador (Google Authenticator, Authy, 1Password…):');
console.log(`   ${r.otpauthUrl}`);
console.log(`   chave manual: ${base32Encode(r.secret)}\n`);
console.log('2) Guarde os códigos de recuperação (uso único, não serão mostrados de novo):');
for (const c of r.recoveryCodes) console.log(`   ${c}`);
console.log('');
