import { escapeHtml } from '../lib/html.js';

/** Variáveis disponíveis nas mensagens. */
export const VARIABLES = ['nome', 'primeiro_nome', 'empresa'] as const;
export type Vars = { nome: string; primeiro_nome: string; empresa: string };

export function varsFor(lead: { name: string; company: string | null }): Vars {
  const nome = (lead.name ?? '').trim();
  return { nome, primeiro_nome: nome.split(/\s+/)[0] ?? '', empresa: (lead.company ?? '').trim() };
}

/** Troca {{nome}}, {{primeiro_nome}} e {{empresa}}. Variável desconhecida fica como está. */
export function fill(template: string, v: Vars): string {
  return template.replace(/\{\{\s*(nome|primeiro_nome|empresa)\s*\}\}/g, (_m, k: keyof Vars) => v[k] ?? '');
}

export interface EmailContent { subject: string; body: string }
export interface SmsContent { text: string }
export interface WhatsAppContent { template: string; language: string; params: string[] }

/**
 * E-mail: o corpo é texto simples digitado pelo cliente. Tudo é escapado (nome do
 * lead incluído — sem XSS) e vira parágrafos. O rodapé com o link de descadastro é
 * obrigatório e não pode ser removido pelo conteúdo.
 */
export function renderEmail(c: EmailContent, v: Vars, footer: { tenantName: string; unsubscribeUrl: string }) {
  const subject = fill(c.subject, v).replace(/[\r\n]+/g, ' ').trim();
  const body = fill(c.body, v);
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#0f172a;max-width:600px">${paragraphs}` +
    `<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0 12px">` +
    `<p style="font-size:12px;color:#64748b;margin:0">Você recebeu esta mensagem de ${escapeHtml(footer.tenantName)}. ` +
    `<a href="${escapeHtml(footer.unsubscribeUrl)}" style="color:#64748b">Não quero mais receber e-mails</a>.</p></div>`;
  const text = `${body}\n\n—\nVocê recebeu esta mensagem de ${footer.tenantName}. Para não receber mais: ${footer.unsubscribeUrl}`;
  return { subject, html, text };
}

export function renderSms(c: SmsContent, v: Vars) {
  return fill(c.text, v).trim();
}

export function renderWhatsApp(c: WhatsAppContent, v: Vars) {
  return { template: c.template, language: c.language, params: c.params.map((p) => fill(p, v)) };
}

// Caracteres do alfabeto GSM-7 (SMS de 160). Fora dele (ã, õ, ê, emoji…) o SMS vira UCS-2 (70).
const GSM7 = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€',
);

/** Quantos SMS (segmentos) a mensagem ocupa — base para estimar custo. */
export function smsSegments(text: string): { encoding: 'GSM-7' | 'UCS-2'; length: number; segments: number } {
  const gsm = [...text].every((ch) => GSM7.has(ch));
  const length = [...text].length;
  if (gsm) return { encoding: 'GSM-7', length, segments: length <= 160 ? 1 : Math.ceil(length / 153) };
  return { encoding: 'UCS-2', length, segments: length <= 70 ? 1 : Math.ceil(length / 67) };
}
