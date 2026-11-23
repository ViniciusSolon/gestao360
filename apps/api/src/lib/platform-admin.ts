import type pg from 'pg';
import { hashPassword, sha256 } from './crypto.js';
import { encryptSecret, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUrl } from './totp.js';

export interface ProvisionInput {
  email: string;
  name: string;
  role: 'superadmin' | 'support';
  password: string;
}

/**
 * Cria (ou recria) um admin da plataforma JÁ com MFA: gera segredo TOTP novo,
 * cifra com PLATFORM_MFA_KEY, troca os códigos de recuperação e zera o anti-replay.
 * Não existe cadastro de admin pela web — só por este caminho (CLI/operador).
 */
export async function provisionPlatformAdmin(pool: pg.Pool, input: ProvisionInput, mfaKeyHex: string) {
  const secret = newTotpSecret();
  const recoveryCodes = newRecoveryCodes();
  const email = input.email.trim().toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<{ id: string }>(
      `INSERT INTO platform_admins (email, name, password_hash, role, totp_secret_enc, totp_last_step)
       VALUES ($1, $2, $3, $4, $5, NULL)
       ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role, totp_secret_enc = EXCLUDED.totp_secret_enc, totp_last_step = NULL
       RETURNING id`,
      [email, input.name, await hashPassword(input.password), input.role, encryptSecret(secret, mfaKeyHex)],
    );
    const adminId = r.rows[0].id;
    await client.query('DELETE FROM platform_recovery_codes WHERE admin_id = $1', [adminId]);
    for (const code of recoveryCodes) {
      await client.query('INSERT INTO platform_recovery_codes (admin_id, code_hash) VALUES ($1, $2)', [adminId, sha256(normalizeRecoveryCode(code))]);
    }
    // Sessões e desafios antigos deixam de valer ao reconfigurar
    await client.query('DELETE FROM platform_sessions WHERE admin_id = $1', [adminId]);
    await client.query('DELETE FROM platform_login_challenges WHERE admin_id = $1', [adminId]);
    await client.query('COMMIT');
    return { adminId, secret, recoveryCodes, otpauthUrl: otpauthUrl('Gestao360 Plataforma', email, secret) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
