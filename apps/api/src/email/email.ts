import { html } from '../lib/html.js';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

/** Transporte de desenvolvimento: só registra. Em produção, troque por SES/Postmark/Resend. */
export class ConsoleEmailSender implements EmailSender {
  async send(msg: EmailMessage) {
    console.log(`[email] para=${msg.to} assunto="${msg.subject}"`);
  }
}

// Templates: toda interpolação passa por escape (tag html``)
export const templates = {
  invite(p: { tenantName: string; inviterName: string; url: string }): Omit<EmailMessage, 'to'> {
    return {
      subject: `Convite para ${p.tenantName} na Gestão 360°`,
      html: html`<p>${p.inviterName} convidou você para a equipe <strong>${p.tenantName}</strong>.</p>
<p><a href="${p.url}">Aceitar convite</a></p><p>O link expira em 7 dias.</p>`,
    };
  },
  ownerAccess(p: { name: string; tenantName: string; url: string }): Omit<EmailMessage, 'to'> {
    return {
      subject: `Seu acesso à Gestão 360° — ${p.tenantName}`,
      html: html`<p>Olá, ${p.name}!</p>
<p>A conta da <strong>${p.tenantName}</strong> na Gestão 360° está pronta. Defina sua senha para entrar:</p>
<p><a href="${p.url}">Definir minha senha</a></p><p>O link vale por 7 dias e pode ser usado uma única vez.</p>`,
    };
  },
  subscriptionActive(p: { tenantName: string; planName: string }): Omit<EmailMessage, 'to'> {
    return {
      subject: 'Assinatura ativada',
      html: html`<p>A assinatura do plano <strong>${p.planName}</strong> para ${p.tenantName} está ativa.</p>`,
    };
  },
};
