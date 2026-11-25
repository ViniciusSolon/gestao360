import { randomUUID } from 'node:crypto';
import type { Client } from '../db/db.js';
import { conflict, notFound, unprocessable } from './errors.js';
import { newToken, sha256 } from './crypto.js';
import { audit } from './limits.js';
import { enqueue } from '../jobs/queue.js';

/** Etapas do funil criadas para toda empresa nova. */
export const DEFAULT_STAGES: [string, number, 'open' | 'won' | 'lost'][] = [
  ['Novo lead', 10, 'open'],
  ['Qualificado', 25, 'open'],
  ['Proposta enviada', 50, 'open'],
  ['Negociação', 75, 'open'],
  ['Ganho', 100, 'won'],
  ['Perdido', 0, 'lost'],
];

export const ACCESS_LINK_TTL_MS = 7 * 24 * 3600 * 1000;

export interface NewTenantInput {
  companyName: string;
  slug: string;
  ownerName: string;
  ownerEmail: string;
  planCode: string;
}

/**
 * Gera (ou regera) o link para o responsável definir a senha. Usa a tabela de
 * convites com papel "owner": o aceite é o mesmo fluxo atômico e de uso único.
 * Precisa rodar numa transação do papel da plataforma.
 */
export async function issueOwnerAccessLink(
  c: Client,
  tenantId: string,
  owner: { name: string; email: string },
  appPublicUrl: string,
  actorAdminId: string | null,
) {
  const hasOwner = await c.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND role = 'owner'`, [tenantId]);
  if (hasOwner.rowCount) throw conflict('Esta empresa já tem responsável com senha definida', 'owner_exists');

  // Links anteriores deixam de valer
  await c.query(
    `UPDATE invites SET revoked_at = now()
      WHERE tenant_id = $1 AND role = 'owner' AND accepted_at IS NULL AND revoked_at IS NULL`,
    [tenantId],
  );
  const token = newToken();
  const inv = await c.query<{ id: string }>(
    `INSERT INTO invites (tenant_id, email, name, role, token_hash, expires_at, created_by)
     VALUES ($1, $2, $3, 'owner', $4, $5, NULL) RETURNING id`,
    [tenantId, owner.email, owner.name, sha256(token), new Date(Date.now() + ACCESS_LINK_TTL_MS)],
  );
  const url = `${appPublicUrl}/convite?token=${encodeURIComponent(token)}`;
  const tenant = (await c.query<{ name: string }>('SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0];
  await enqueue(c, {
    type: 'email.owner_access',
    tenantId,
    payload: { to: owner.email, name: owner.name, tenantName: tenant.name, url },
    dedupeKey: `email:owner_access:${inv.rows[0].id}`,
  });
  await audit(c, {
    tenantId, actorType: actorAdminId ? 'platform_admin' : 'system', actorId: actorAdminId,
    action: 'platform.owner_access_link', targetType: 'invite', targetId: inv.rows[0].id,
  });
  return { inviteId: inv.rows[0].id, url };
}

/**
 * Cria uma empresa cliente (já ativa, sem período de teste), o funil padrão e o
 * link para o responsável definir a senha. Só a plataforma chama isto.
 */
export async function provisionTenant(c: Client, input: NewTenantInput, appPublicUrl: string, actorAdminId: string | null) {
  const email = input.ownerEmail.trim().toLowerCase();
  // O e-mail identifica o usuário em toda a plataforma: não pode já existir
  const used = await c.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
  if (used.rowCount) throw conflict('Já existe um usuário com este e-mail', 'email_in_use');

  const plan = (await c.query<{ id: string }>('SELECT id FROM plans WHERE code = $1', [input.planCode])).rows[0];
  if (!plan) throw unprocessable('Plano inexistente', 'invalid_plan');

  const tenantId = randomUUID();
  await c.query(`INSERT INTO tenants (id, name, slug, plan_id, status) VALUES ($1, $2, $3, $4, 'active')`, [
    tenantId, input.companyName.trim(), input.slug, plan.id,
  ]);
  for (const [i, [name, prob, kind]] of DEFAULT_STAGES.entries()) {
    await c.query(`INSERT INTO pipeline_stages (tenant_id, name, position, probability, kind) VALUES ($1, $2, $3, $4, $5)`, [
      tenantId, name, i, prob, kind,
    ]);
  }
  await audit(c, {
    tenantId, actorType: actorAdminId ? 'platform_admin' : 'system', actorId: actorAdminId,
    action: 'platform.tenant_created', metadata: { plan: input.planCode, ownerEmail: email },
  });
  const link = await issueOwnerAccessLink(c, tenantId, { name: input.ownerName.trim(), email }, appPublicUrl, actorAdminId);
  return { tenantId, ...link };
}

export async function assertTenantExists(c: Client, tenantId: string) {
  const r = await c.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
  if (!r.rowCount) throw notFound('Cliente não encontrado');
}
