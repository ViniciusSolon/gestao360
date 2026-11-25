import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Client } from '../db/db.js';
import { authOf } from '../auth/guards.js';
import { AppError, notFound, unprocessable } from '../lib/errors.js';
import { audit } from '../lib/limits.js';
import { normalizeBrPhone } from '../lib/phone.js';
import { openSecret, sealSecret, secretHint } from '../lib/secretbox.js';
import { ProviderError, type Channel, type EmailCreds, type SmsCreds, type WhatsAppCreds } from '../messaging/providers.js';
import { guard } from './common.js';

export const CHANNELS = ['email', 'whatsapp', 'sms'] as const;
const PROVIDER: Record<Channel, 'resend' | 'meta' | 'zenvia'> = { email: 'resend', whatsapp: 'meta', sms: 'zenvia' };
const channelParam = z.object({ channel: z.enum(CHANNELS) });

// O segredo é opcional na edição: vazio = mantém o que já está salvo
const secret = z.string().trim().min(8).max(2000).optional();
const BODY = {
  email: z.object({
    fromName: z.string().trim().min(1).max(80),
    fromEmail: z.string().trim().toLowerCase().email().max(200),
    apiKey: secret,
  }),
  whatsapp: z.object({
    phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'Phone number ID: só números, como aparece no painel da Meta'),
    defaultLanguage: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/, 'Ex.: pt_BR').default('pt_BR'),
    accessToken: secret,
  }),
  sms: z.object({
    from: z.string().trim().min(2).max(40),
    apiToken: secret,
  }),
};

export class ChannelsNotConfigured extends AppError {
  constructor() {
    super(503, 'channels_unavailable', 'O servidor ainda não tem a chave CHANNEL_SECRETS_KEY configurada. Fale com o suporte.');
  }
}

export function requireChannelKey(deps: Deps): string {
  const k = deps.config.CHANNEL_SECRETS_KEY;
  if (!k) throw new ChannelsNotConfigured();
  return k;
}

export type AnyCreds = { channel: 'email'; creds: EmailCreds } | { channel: 'whatsapp'; creds: WhatsAppCreds; language: string } | { channel: 'sms'; creds: SmsCreds };

/** Lê e decifra as credenciais de um canal (só no servidor). null = canal não conectado. */
export async function loadChannelCreds(c: Client, tenantId: string, channel: Channel, key: string): Promise<AnyCreds | null> {
  const row = (await c.query('SELECT settings, secret_enc FROM tenant_channels WHERE tenant_id = $1 AND channel = $2', [tenantId, channel])).rows[0];
  if (!row) return null;
  const s = row.settings;
  const sec = openSecret(row.secret_enc, key);
  if (channel === 'email') return { channel, creds: { apiKey: sec, fromEmail: s.fromEmail, fromName: s.fromName } };
  if (channel === 'whatsapp') return { channel, creds: { accessToken: sec, phoneNumberId: s.phoneNumberId }, language: s.defaultLanguage ?? 'pt_BR' };
  return { channel: 'sms', creds: { apiToken: sec, from: s.from } };
}

export async function channelRoutes(app: FastifyInstance, deps: Deps) {
  const { db } = deps;

  /** Situação dos 3 canais. Nunca devolve o token, só a dica (••••1a2b). */
  app.get('/channels', { preHandler: guard(deps, 'manager') }, async (req) => {
    const a = authOf(req);
    const rows = await db.withAuth(a, async (c) =>
      (await c.query('SELECT channel, provider, settings, secret_hint, updated_at FROM tenant_channels')).rows,
    );
    return CHANNELS.map((ch) => {
      const r = rows.find((x) => x.channel === ch);
      return {
        channel: ch,
        provider: PROVIDER[ch],
        configured: !!r,
        settings: r?.settings ?? {},
        secretHint: r?.secret_hint ?? null,
        updatedAt: r?.updated_at ?? null,
        serverReady: !!deps.config.CHANNEL_SECRETS_KEY,
        mode: deps.messaging.mode,
      };
    });
  });

  app.put('/channels/:channel', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { channel } = channelParam.parse(req.params);
    const key = requireChannelKey(deps);
    const b = BODY[channel].parse(req.body) as Record<string, string | undefined>;
    const secretField = channel === 'email' ? 'apiKey' : channel === 'whatsapp' ? 'accessToken' : 'apiToken';
    const newSecret = b[secretField];
    const settings = Object.fromEntries(Object.entries(b).filter(([k]) => k !== secretField));
    return db.withAuth(a, async (c) => {
      const existing = (await c.query('SELECT 1 FROM tenant_channels WHERE channel = $1', [channel])).rowCount;
      if (!newSecret && !existing) throw unprocessable('Informe o token/chave de API do provedor', 'secret_required');
      if (newSecret) {
        await c.query(
          `INSERT INTO tenant_channels (tenant_id, channel, provider, settings, secret_enc, secret_hint, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, channel) DO UPDATE SET settings = EXCLUDED.settings, secret_enc = EXCLUDED.secret_enc,
             secret_hint = EXCLUDED.secret_hint, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [a.tenantId, channel, PROVIDER[channel], JSON.stringify(settings), sealSecret(newSecret, key), secretHint(newSecret), a.userId],
        );
      } else {
        await c.query('UPDATE tenant_channels SET settings = $2, updated_by = $3, updated_at = now() WHERE channel = $1', [
          channel, JSON.stringify(settings), a.userId,
        ]);
      }
      // O segredo nunca entra na auditoria
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'channel.saved', targetType: 'channel', targetId: channel, metadata: { settings, secretChanged: !!newSecret }, ip: req.ip });
      return { ok: true };
    });
  });

  app.delete('/channels/:channel', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { channel } = channelParam.parse(req.params);
    return db.withAuth(a, async (c) => {
      const r = await c.query('DELETE FROM tenant_channels WHERE channel = $1 RETURNING channel', [channel]);
      if (!r.rowCount) throw notFound('Canal não conectado');
      await audit(c, { tenantId: a.tenantId, actorType: 'user', actorId: a.userId, action: 'channel.removed', targetType: 'channel', targetId: channel, ip: req.ip });
      return { ok: true };
    });
  });

  /** Envia uma mensagem de teste para conferir se a conta está certa. */
  app.post('/channels/:channel/test', { preHandler: guard(deps, 'admin') }, async (req) => {
    const a = authOf(req);
    const { channel } = channelParam.parse(req.params);
    const key = requireChannelKey(deps);
    const { to, template } = z.object({ to: z.string().trim().min(3).max(200), template: z.string().trim().max(120).optional() }).parse(req.body);
    const ch = await db.withAuth(a, (c) => loadChannelCreds(c, a.tenantId, channel, key));
    if (!ch) throw unprocessable('Conecte o canal antes de testar', 'channel_not_configured');
    try {
      if (ch.channel === 'email') {
        if (!z.string().email().safeParse(to).success) throw unprocessable('E-mail inválido');
        const r = await deps.messaging.sendEmail(ch.creds, {
          to, subject: `Teste de envio — ${a.tenantName}`, headers: {},
          html: '<p>Se você recebeu este e-mail, o canal de e-mail da Gestão 360° está funcionando.</p>',
          text: 'Se você recebeu este e-mail, o canal de e-mail da Gestão 360° está funcionando.',
        }, `test-${a.tenantId}-${Date.now()}`);
        return { ok: true, id: r.id };
      }
      const phone = normalizeBrPhone(to);
      if (!phone) throw unprocessable('Telefone inválido (use DDD + número)');
      if (ch.channel === 'sms') {
        const r = await deps.messaging.sendSms(ch.creds, { to: phone, text: `Teste de envio da ${a.tenantName}: o SMS está funcionando.` });
        return { ok: true, id: r.id };
      }
      // WhatsApp só aceita mensagem ativa por template aprovado; "hello_world" é o template de teste da Meta
      const r = await deps.messaging.sendWhatsApp(ch.creds, { to: phone, template: template || 'hello_world', language: template ? ch.language : 'en_US', params: [] });
      return { ok: true, id: r.id };
    } catch (e) {
      if (e instanceof ProviderError) throw unprocessable(e.message, 'provider_error');
      throw e;
    }
  });
}
