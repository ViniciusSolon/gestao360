import type { Deps } from '../deps.js';
import { enqueue } from '../jobs/queue.js';

/** Mapeia o status do gateway para o status do tenant. */
export function tenantStatusFor(gatewayStatus: string): 'active' | 'past_due' | 'canceled' | null {
  switch (gatewayStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return null; // incomplete: aguarda
  }
}

/**
 * Sincroniza a assinatura buscando o estado ATUAL no gateway (não confia no
 * payload nem na ordem dos eventos). Idempotente: rodar N vezes dá o mesmo resultado.
 */
export async function syncSubscription(deps: Deps, subscriptionId: string) {
  const sub = await deps.gateway.retrieveSubscription(subscriptionId);
  if (!sub.tenantId || !sub.planCode) throw new Error(`assinatura ${sub.id} sem metadata de tenant/plano`);

  await deps.db.withPlatform(async (c) => {
    const plan = (await c.query('SELECT id, name FROM plans WHERE code = $1', [sub.planCode])).rows[0];
    if (!plan) throw new Error(`plano ${sub.planCode} desconhecido`);

    // Lock da linha do tenant: serializa syncs concorrentes da mesma conta
    const t = (await c.query('SELECT id, name, status FROM tenants WHERE id = $1 FOR UPDATE', [sub.tenantId])).rows[0];
    if (!t) throw new Error(`tenant ${sub.tenantId} não existe`);

    await c.query(
      `INSERT INTO subscriptions (tenant_id, provider_subscription_id, status, plan_id, current_period_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id) DO UPDATE SET provider_subscription_id = EXCLUDED.provider_subscription_id,
         status = EXCLUDED.status, plan_id = EXCLUDED.plan_id,
         current_period_end = EXCLUDED.current_period_end, updated_at = now()`,
      [sub.tenantId, sub.id, sub.status, plan.id, sub.currentPeriodEnd],
    );

    const next = tenantStatusFor(sub.status);
    // Suspensão manual da plataforma prevalece sobre o gateway
    if (next && t.status !== 'suspended') {
      await c.query('UPDATE tenants SET status = $2, plan_id = $3 WHERE id = $1', [t.id, next, plan.id]);
    }
    await c.query(
      `UPDATE billing_operations SET status = 'completed'
        WHERE tenant_id = $1 AND plan_id = $2 AND status = 'pending'`,
      [t.id, plan.id],
    );
    await c.query(
      `INSERT INTO audit_log (tenant_id, actor_type, action, target_type, target_id, metadata)
       VALUES ($1, 'system', 'billing.subscription_synced', 'subscription', $2, $3)`,
      [t.id, sub.id, JSON.stringify({ status: sub.status, plan: sub.planCode })],
    );

    if (next === 'active') {
      const owner = (await c.query(`SELECT email FROM users WHERE tenant_id = $1 AND role = 'owner'`, [t.id])).rows[0];
      if (owner) {
        // dedupe por assinatura + período: e-mail sai uma vez por ciclo, mesmo com eventos repetidos
        const period = sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString().slice(0, 10) : 'na';
        await enqueue(c, {
          type: 'email.subscription_active',
          tenantId: t.id,
          payload: { to: owner.email, tenantName: t.name, planName: plan.name },
          dedupeKey: `email:subscription_active:${sub.id}:${period}`,
        });
      }
    }
  });
}
