/**
 * Provedores de envio. Cada empresa cliente usa as PRÓPRIAS credenciais:
 *  - E-mail:   Resend (https://resend.com) — domínio verificado no Resend
 *  - WhatsApp: WhatsApp Cloud API da Meta — só templates aprovados (marketing)
 *  - SMS:      Zenvia (https://zenvia.com) — remetente cadastrado na Zenvia
 *
 * "Fake" (desenvolvimento e testes) só registra em memória. É o único mock permitido:
 * serviço externo.
 */
export type Channel = 'email' | 'whatsapp' | 'sms';

export interface EmailMessage { to: string; subject: string; html: string; text: string; headers: Record<string, string> }
export interface SmsMessage { to: string; text: string }
export interface WhatsAppMessage { to: string; template: string; language: string; params: string[] }

export interface EmailCreds { apiKey: string; fromEmail: string; fromName: string }
export interface WhatsAppCreds { accessToken: string; phoneNumberId: string }
export interface SmsCreds { apiToken: string; from: string }

export interface SendResult { id: string }

export interface MessagingProviders {
  readonly mode: 'live' | 'fake';
  sendEmail(c: EmailCreds, m: EmailMessage, idempotencyKey: string): Promise<SendResult>;
  sendWhatsApp(c: WhatsAppCreds, m: WhatsAppMessage): Promise<SendResult>;
  sendSms(c: SmsCreds, m: SmsMessage): Promise<SendResult>;
}

/** Erro do provedor com mensagem curta e segura para mostrar ao cliente. */
export class ProviderError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    throw new ProviderError((e as Error).name === 'AbortError' ? 'Provedor não respondeu a tempo' : 'Falha de rede ao falar com o provedor');
  } finally {
    clearTimeout(timer);
  }
}

export class LiveProviders implements MessagingProviders {
  readonly mode = 'live' as const;
  constructor(private readonly graphVersion: string) {}

  async sendEmail(c: EmailCreds, m: EmailMessage, idempotencyKey: string) {
    const r = await postJson(
      'https://api.resend.com/emails',
      { Authorization: `Bearer ${c.apiKey}`, 'Idempotency-Key': idempotencyKey },
      { from: `${c.fromName} <${c.fromEmail}>`, to: [m.to], subject: m.subject, html: m.html, text: m.text, headers: m.headers },
    );
    if (!r.ok || !r.json?.id) throw new ProviderError(`Resend ${r.status}: ${String(r.json?.message ?? 'erro').slice(0, 200)}`, r.status);
    return { id: String(r.json.id) };
  }

  async sendWhatsApp(c: WhatsAppCreds, m: WhatsAppMessage) {
    const r = await postJson(
      `https://graph.facebook.com/${this.graphVersion}/${encodeURIComponent(c.phoneNumberId)}/messages`,
      { Authorization: `Bearer ${c.accessToken}` },
      {
        messaging_product: 'whatsapp',
        to: m.to,
        type: 'template',
        template: {
          name: m.template,
          language: { code: m.language },
          ...(m.params.length ? { components: [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text })) }] } : {}),
        },
      },
    );
    const id = r.json?.messages?.[0]?.id;
    if (!r.ok || !id) throw new ProviderError(`WhatsApp ${r.status}: ${String(r.json?.error?.message ?? 'erro').slice(0, 200)}`, r.status);
    return { id: String(id) };
  }

  async sendSms(c: SmsCreds, m: SmsMessage) {
    const r = await postJson(
      'https://api.zenvia.com/v2/channels/sms/messages',
      { 'X-API-TOKEN': c.apiToken },
      { from: c.from, to: m.to, contents: [{ type: 'text', text: m.text }] },
    );
    if (!r.ok || !r.json?.id) throw new ProviderError(`Zenvia ${r.status}: ${String(r.json?.message ?? 'erro').slice(0, 200)}`, r.status);
    return { id: String(r.json.id) };
  }
}

/** Desenvolvimento/testes: não envia nada; endereços com "falha" simulam erro do provedor. */
export class FakeProviders implements MessagingProviders {
  readonly mode = 'fake' as const;
  sent: { channel: Channel; to: string; payload: unknown; idempotencyKey?: string }[] = [];
  private n = 0;
  private maybeFail(to: string) {
    if (to.includes('falha') || to.endsWith('0000000')) throw new ProviderError('Destinatário recusado pelo provedor (simulado)', 400);
  }
  async sendEmail(_c: EmailCreds, m: EmailMessage, idempotencyKey: string) {
    this.maybeFail(m.to);
    this.sent.push({ channel: 'email', to: m.to, payload: m, idempotencyKey });
    return { id: `fake-email-${++this.n}` };
  }
  async sendWhatsApp(_c: WhatsAppCreds, m: WhatsAppMessage) {
    this.maybeFail(m.to);
    this.sent.push({ channel: 'whatsapp', to: m.to, payload: m });
    return { id: `fake-wa-${++this.n}` };
  }
  async sendSms(_c: SmsCreds, m: SmsMessage) {
    this.maybeFail(m.to);
    this.sent.push({ channel: 'sms', to: m.to, payload: m });
    return { id: `fake-sms-${++this.n}` };
  }
}
