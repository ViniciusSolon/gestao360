import type { Deps } from '../deps.js';
import { enqueue } from '../jobs/queue.js';
import { signOptOut } from '../lib/secretbox.js';
import { loadChannelCreds } from '../modules/channels.js';
import { ProviderError } from './providers.js';
import { renderEmail, renderSms, renderWhatsApp, varsFor, type EmailContent, type SmsContent, type WhatsAppContent } from './render.js';

const BATCH = 25;
const PER_RUN = 200; // por execução do job; o resto continua em outro job (não segura o worker)

/**
 * Envia uma campanha. Roda no worker (papel da plataforma).
 * - Pega destinatários com FOR UPDATE SKIP LOCKED: dois workers nunca pegam o mesmo.
 * - Destinatário "preso" em envio (worker caiu) vira FALHA, não é reenviado: melhor não
 *   entregar do que entregar duas vezes.
 * - Confere cancelamento entre lotes.
 */
export async function dispatchCampaign(deps: Deps, campaignId: string, run: number) {
  const { db } = deps;
  const camp = (
    await db.platform.query(
      `SELECT c.*, t.name AS tenant_name, t.status AS tenant_status FROM campaigns c JOIN tenants t ON t.id = c.tenant_id WHERE c.id = $1`,
      [campaignId],
    )
  ).rows[0];
  if (!camp || !['scheduled', 'sending'].includes(camp.status)) return;

  const skipAll = async (reason: string, campaignStatus: 'canceled' | 'sent') => {
    await db.withPlatform(async (c) => {
      await c.query(`UPDATE campaign_recipients SET status = 'skipped', error = $2 WHERE campaign_id = $1 AND status = 'pending'`, [campaignId, reason]);
      await c.query(`UPDATE campaigns SET status = $2, finished_at = now() WHERE id = $1 AND status IN ('scheduled','sending')`, [campaignId, campaignStatus]);
    });
  };
  if (!['active', 'past_due', 'trialing'].includes(camp.tenant_status)) return skipAll('Conta suspensa ou cancelada', 'canceled');

  const key = deps.config.CHANNEL_SECRETS_KEY;
  const ch = key ? await db.withPlatform((c) => loadChannelCreds(c, camp.tenant_id, camp.channel, key)) : null;
  if (!ch || !key) {
    await db.withPlatform((c) =>
      c.query(`UPDATE campaign_recipients SET status = 'failed', error = 'Canal não conectado' WHERE campaign_id = $1 AND status = 'pending'`, [campaignId]),
    );
    return finish(deps, campaignId);
  }

  await db.platform.query(`UPDATE campaigns SET status = 'sending', started_at = coalesce(started_at, now()) WHERE id = $1 AND status = 'scheduled'`, [campaignId]);
  await db.platform.query(
    `UPDATE campaign_recipients SET status = 'failed', error = 'Envio interrompido; não reenviado para evitar mensagem duplicada'
      WHERE campaign_id = $1 AND status = 'sending' AND claimed_at < now() - interval '10 minutes'`,
    [campaignId],
  );

  const base = deps.config.APP_PUBLIC_URL;
  let processed = 0;
  while (processed < PER_RUN) {
    const still = (await db.platform.query('SELECT status FROM campaigns WHERE id = $1', [campaignId])).rows[0];
    if (still?.status !== 'sending') return; // cancelada no meio
    const batch = (
      await db.platform.query(
        `UPDATE campaign_recipients SET status = 'sending', claimed_at = now(), attempts = attempts + 1
          WHERE id IN (SELECT id FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'
                        ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
          RETURNING id, address, vars`,
        [campaignId],
      )
    ).rows;
    if (!batch.length) break;
    for (const r of batch) {
      const v = varsFor({ name: r.vars.name, company: r.vars.company });
      try {
        let res;
        if (ch.channel === 'email') {
          const token = signOptOut({ t: camp.tenant_id, c: 'email', a: r.address }, key);
          const page = `${base}/descadastro?token=${encodeURIComponent(token)}`;
          const oneClick = `${base}/api/public/unsubscribe?token=${encodeURIComponent(token)}`;
          const m = renderEmail(camp.content as EmailContent, v, { tenantName: camp.tenant_name, unsubscribeUrl: page });
          res = await deps.messaging.sendEmail(
            ch.creds,
            { to: r.address, ...m, headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } },
            `campaign-recipient-${r.id}`,
          );
        } else if (ch.channel === 'sms') {
          res = await deps.messaging.sendSms(ch.creds, { to: r.address, text: renderSms(camp.content as SmsContent, v) });
        } else {
          res = await deps.messaging.sendWhatsApp(ch.creds, { to: r.address, ...renderWhatsApp(camp.content as WhatsAppContent, v) });
        }
        await db.platform.query(`UPDATE campaign_recipients SET status = 'sent', provider_message_id = $2, sent_at = now(), error = NULL WHERE id = $1`, [r.id, res.id]);
      } catch (e) {
        const msg = e instanceof ProviderError ? e.message : 'Erro inesperado no envio';
        await db.platform.query(`UPDATE campaign_recipients SET status = 'failed', error = $2 WHERE id = $1`, [r.id, msg.slice(0, 500)]);
      }
      processed++;
    }
  }

  const pending = Number((await db.platform.query(`SELECT count(*) FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`, [campaignId])).rows[0].count);
  if (pending > 0) {
    await db.withPlatform((c) =>
      enqueue(c, { type: 'campaign.dispatch', tenantId: camp.tenant_id, payload: { campaignId, run: run + 1 }, dedupeKey: `campaign:${campaignId}:${run + 1}` }),
    );
    return;
  }
  return finish(deps, campaignId);
}

async function finish(deps: Deps, campaignId: string) {
  await deps.db.platform.query(
    `UPDATE campaigns SET status = 'sent', finished_at = now()
      WHERE id = $1 AND status IN ('scheduled','sending')
        AND NOT EXISTS (SELECT 1 FROM campaign_recipients WHERE campaign_id = $1 AND status IN ('pending','sending'))`,
    [campaignId],
  );
}
