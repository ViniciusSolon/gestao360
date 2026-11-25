import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, call, CHANNEL_KEY, createLead, createTestApp, ORIGIN, resetDb, signup, stages, type Session, type TestCtx } from './helpers.js';
import { drainJobs } from '../src/jobs/runner.js';
import { dispatchCampaign } from '../src/messaging/dispatch.js';
import { smsSegments } from '../src/messaging/render.js';
import { normalizeBrPhone } from '../src/lib/phone.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => { await resetDb(t.db); t.messaging.sent = []; });

const RESEND_KEY = 're_live_SEGREDO_resend_123456';
async function connectAll(s: Session) {
  expect((await call(t.app, s, 'PUT', '/api/channels/email', { fromName: 'Usaplast', fromEmail: 'contato@usaplast.com.br', apiKey: RESEND_KEY })).statusCode).toBe(200);
  expect((await call(t.app, s, 'PUT', '/api/channels/whatsapp', { phoneNumberId: '109876543210', accessToken: 'EAAG-segredo-meta-999999' })).statusCode).toBe(200);
  expect((await call(t.app, s, 'PUT', '/api/channels/sms', { from: 'USAPLAST', apiToken: 'zenvia-segredo-777777' })).statusCode).toBe(200);
}
async function newCampaign(s: Session, body: Record<string, unknown>) {
  const r = await call(t.app, s, 'POST', '/api/campaigns', body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
const emailCampaign = (extra: Record<string, unknown> = {}) => ({
  channel: 'email', name: 'Black Friday', content: { subject: 'Oferta para {{empresa}}', body: 'Olá, {{primeiro_nome}}!\n\nTemos condições especiais.' }, ...extra,
});
const recipientsOf = async (campaignId: string) =>
  (await t.db.platform.query('SELECT address, status, error FROM campaign_recipients WHERE campaign_id = $1 ORDER BY address', [campaignId])).rows;

describe('Canais (contas de cada empresa)', () => {
  it('quando salva os canais, então o token fica cifrado no banco e nunca volta para a tela (só a dica)', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    const r = await call(t.app, s, 'GET', '/api/channels');
    expect(r.body).not.toContain(RESEND_KEY);
    expect(r.body).not.toContain('EAAG-segredo');
    const email = r.json().find((c: any) => c.channel === 'email');
    expect(email).toMatchObject({ configured: true, provider: 'resend', secretHint: '••••3456', settings: { fromName: 'Usaplast', fromEmail: 'contato@usaplast.com.br' } });
    const db = (await t.db.platform.query(`SELECT secret_enc FROM tenant_channels WHERE channel = 'email'`)).rows[0].secret_enc;
    expect(db).toMatch(/^v1:/);
    expect(db).not.toContain('SEGREDO');
  });

  it('quando edita só o remetente, então o token salvo continua valendo; sem token na primeira vez, 422', async () => {
    const s = await signup(t.app);
    expect((await call(t.app, s, 'PUT', '/api/channels/sms', { from: 'LOJA' })).statusCode).toBe(422);
    await connectAll(s);
    expect((await call(t.app, s, 'PUT', '/api/channels/email', { fromName: 'Nova Marca', fromEmail: 'oi@usaplast.com.br' })).statusCode).toBe(200);
    expect((await call(t.app, s, 'POST', '/api/channels/email/test', { to: 'eu@exemplo.com' })).statusCode).toBe(200);
    expect(t.messaging.sent.at(-1)).toMatchObject({ channel: 'email', to: 'eu@exemplo.com' });
  });

  it('quando testa o canal, então valida o destino e mostra o erro do provedor de forma clara', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    expect((await call(t.app, s, 'POST', '/api/channels/sms/test', { to: '123' })).statusCode).toBe(422);
    expect((await call(t.app, s, 'POST', '/api/channels/sms/test', { to: '(11) 98888-7777' })).json()).toMatchObject({ ok: true });
    expect(t.messaging.sent.at(-1)).toMatchObject({ channel: 'sms', to: '5511988887777' });
    const fail = await call(t.app, s, 'POST', '/api/channels/email/test', { to: 'falha@exemplo.com' });
    expect([fail.statusCode, fail.json().error]).toEqual([422, 'provider_error']);
  });

  it('quando vendedor ou gerente tentam conectar canal, então 403; gerente pode ver a situação', async () => {
    const owner = await signup(t.app);
    const mgr = await addMember(t.app, owner, 'manager');
    const seller = await addMember(t.app, owner, 'seller');
    expect((await call(t.app, mgr, 'PUT', '/api/channels/sms', { from: 'X', apiToken: 'token-qualquer-123' })).statusCode).toBe(403);
    expect((await call(t.app, mgr, 'GET', '/api/channels')).statusCode).toBe(200);
    expect((await call(t.app, seller, 'GET', '/api/channels')).statusCode).toBe(403);
  });

  it('quando o servidor não tem CHANNEL_SECRETS_KEY, então conectar canal responde 503 (não grava token em claro)', async () => {
    const a = await createTestApp({ CHANNEL_SECRETS_KEY: undefined });
    try {
      const s = await signup(a.app);
      expect((await call(a.app, s, 'PUT', '/api/channels/sms', { from: 'X', apiToken: 'token-qualquer-123' })).statusCode).toBe(503);
    } finally { await a.app.close(); await a.db.close(); }
  });
});

describe('Campanha de e-mail', () => {
  async function scenario() {
    const s = await signup(t.app);
    await connectAll(s);
    await createLead(t.app, s, { name: 'Marcos Pereira', company: 'Metalúrgica Sul', email: 'marcos@sul.com' });
    await createLead(t.app, s, { name: '<img src=x onerror=alert(1)> Hacker', company: 'Ataque', email: 'hacker@x.com' });
    await createLead(t.app, s, { name: 'Sem Email', company: 'X' });
    await createLead(t.app, s, { name: 'Marcos Duplicado', email: 'MARCOS@sul.com' });
    await createLead(t.app, s, { name: 'Saiu da Lista', email: 'saiu@x.com' });
    await call(t.app, s, 'POST', '/api/opt-outs', { channel: 'email', address: 'Saiu@x.com' });
    return s;
  }

  it('quando pré-visualiza o público, então mostra quem recebe e por que os outros não', async () => {
    const s = await scenario();
    const r = (await call(t.app, s, 'POST', '/api/campaigns/audience-preview', { channel: 'email', audience: {} })).json();
    expect(r).toMatchObject({ matched: 5, reachable: 2, missingAddress: 1, optedOut: 1, duplicates: 1 });
  });

  it('quando envia, então cada endereço recebe uma vez, com variáveis, nome escapado e link de descadastro', async () => {
    const s = await scenario();
    const c = await newCampaign(s, emailCampaign());
    const sent = await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`);
    expect(sent.json()).toMatchObject({ recipients: 2, optedOut: 1, missingAddress: 1, duplicates: 1 });
    await drainJobs(t.deps);
    expect(t.messaging.sent.map((m) => m.to).sort()).toEqual(['hacker@x.com', 'marcos@sul.com']);
    const marcos = t.messaging.sent.find((m) => m.to === 'marcos@sul.com')!.payload as any;
    expect(marcos.subject).toBe('Oferta para Metalúrgica Sul');
    expect(marcos.html).toContain('Olá, Marcos!');
    expect(marcos.html).toMatch(/\/descadastro\?token=/);
    expect(marcos.headers['List-Unsubscribe']).toMatch(/^<http.*\/api\/public\/unsubscribe\?token=/);
    expect(marcos.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const hacker = t.messaging.sent.find((m) => m.to === 'hacker@x.com')!.payload as any;
    expect(hacker.html).not.toContain('<img');
    expect(hacker.html).toContain('&lt;img');
    const d = (await call(t.app, s, 'GET', `/api/campaigns/${c.id}`)).json();
    expect(d.status).toBe('sent');
    expect(d.stats).toMatchObject({ total: 2, sent: 2, failed: 0 });
  });

  it('quando clicam duas vezes em enviar (ao mesmo tempo), então dispara uma vez só', async () => {
    const s = await scenario();
    const c = await newCampaign(s, emailCampaign());
    const rs = await Promise.all([1, 2, 3].map(() => call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`)));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    await drainJobs(t.deps);
    await drainJobs(t.deps);
    expect(t.messaging.sent).toHaveLength(2);
  });

  it('quando dois workers processam a mesma campanha ao mesmo tempo, então ninguém recebe duas vezes', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    for (let i = 0; i < 30; i++) await createLead(t.app, s, { name: `Lead ${i}`, email: `lead${i}@x.com` });
    const c = await newCampaign(s, emailCampaign());
    await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`);
    await Promise.all([dispatchCampaign(t.deps, c.id, 0), dispatchCampaign(t.deps, c.id, 0), dispatchCampaign(t.deps, c.id, 0)]);
    const to = t.messaging.sent.map((m) => m.to);
    expect(to).toHaveLength(30);
    expect(new Set(to).size).toBe(30);
  });

  it('quando o provedor recusa um destinatário, então só ele fica com falha e a campanha termina', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    await createLead(t.app, s, { name: 'Ok', email: 'ok@x.com' });
    await createLead(t.app, s, { name: 'Ruim', email: 'falha@x.com' });
    const c = await newCampaign(s, emailCampaign());
    await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`);
    await drainJobs(t.deps);
    expect(await recipientsOf(c.id)).toEqual([
      { address: 'falha@x.com', status: 'failed', error: 'Destinatário recusado pelo provedor (simulado)' },
      { address: 'ok@x.com', status: 'sent', error: null },
    ]);
    expect((await call(t.app, s, 'GET', `/api/campaigns/${c.id}`)).json().status).toBe('sent');
  });

  it('quando o envio foi interrompido (worker caiu com a mensagem "em envio"), então vira falha e NÃO é reenviada', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    await createLead(t.app, s, { name: 'A', email: 'a@x.com' });
    await createLead(t.app, s, { name: 'B', email: 'b@x.com' });
    const c = await newCampaign(s, emailCampaign());
    await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`);
    await t.db.platform.query(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [c.id]);
    await t.db.platform.query(`UPDATE campaign_recipients SET status = 'sending', claimed_at = now() - interval '20 minutes' WHERE address = 'a@x.com'`);
    await dispatchCampaign(t.deps, c.id, 0);
    expect(t.messaging.sent.map((m) => m.to)).toEqual(['b@x.com']);
    expect((await recipientsOf(c.id))[0]).toMatchObject({ address: 'a@x.com', status: 'failed' });
  });
});

describe('Descadastro (LGPD)', () => {
  async function sentTo(address: string) {
    const s = await signup(t.app);
    await connectAll(s);
    await createLead(t.app, s, { name: 'Pessoa', email: address });
    const c = await newCampaign(s, emailCampaign());
    await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`);
    await drainJobs(t.deps);
    const html = (t.messaging.sent.at(-1)!.payload as any).html as string;
    const token = decodeURIComponent(html.match(/descadastro\?token=([^"&]+)/)![1]);
    return { s, token };
  }

  it('quando a pessoa clica no link, então é descadastrada e não recebe a próxima campanha', async () => {
    const { s, token } = await sentTo('pessoa@x.com');
    const r = await t.app.inject({ method: 'POST', url: '/api/public/unsubscribe', headers: { origin: ORIGIN }, payload: { token } });
    expect(r.json()).toEqual({ ok: true, channel: 'email' });
    const prev = (await call(t.app, s, 'POST', '/api/campaigns/audience-preview', { channel: 'email', audience: {} })).json();
    expect(prev).toMatchObject({ reachable: 0, optedOut: 1 });
  });

  it('quando o Gmail usa o descadastro de um clique (form-urlencoded), então também funciona', async () => {
    const { s, token } = await sentTo('gmail@x.com');
    const r = await t.app.inject({
      method: 'POST', url: `/api/public/unsubscribe?token=${encodeURIComponent(token)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click',
    });
    expect(r.statusCode).toBe(200);
    expect((await call(t.app, s, 'GET', '/api/opt-outs')).json()).toEqual([expect.objectContaining({ channel: 'email', address: 'gmail@x.com', source: 'link' })]);
  });

  it('quando o token é adulterado (outro e-mail ou outra empresa), então 400 e nada é gravado', async () => {
    const { token } = await sentTo('alvo@x.com');
    const [payload, sig] = token.split('.');
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = `${Buffer.from(JSON.stringify({ ...claim, a: 'outra@x.com' })).toString('base64url')}.${sig}`;
    expect((await t.app.inject({ method: 'POST', url: '/api/public/unsubscribe', payload: { token: forged } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/public/unsubscribe', payload: { token: 'lixo' } })).statusCode).toBe(400);
    expect(Number((await t.db.platform.query('SELECT count(*) FROM contact_opt_outs')).rows[0].count)).toBe(0);
  });
});

describe('Campanhas de SMS e WhatsApp', () => {
  it('quando envia SMS, então só celulares válidos recebem (fixo e inválido ficam de fora) e o texto é personalizado', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    await createLead(t.app, s, { name: 'Celular', phone: '(11) 98888-1111' });
    await createLead(t.app, s, { name: 'Fixo', phone: '(11) 3333-4444' });
    await createLead(t.app, s, { name: 'Inválido', phone: '1234' });
    await call(t.app, s, 'POST', '/api/opt-outs', { channel: 'sms', address: '+55 11 97777-2222' });
    await createLead(t.app, s, { name: 'Pediu pra sair', phone: '11977772222' });
    const c = await newCampaign(s, { channel: 'sms', name: 'Promo', content: { text: 'Oi {{primeiro_nome}}, promo hoje!' } });
    expect((await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`)).json()).toMatchObject({ recipients: 1, optedOut: 1, missingAddress: 2 });
    await drainJobs(t.deps);
    expect(t.messaging.sent).toEqual([expect.objectContaining({ channel: 'sms', to: '5511988881111', payload: { to: '5511988881111', text: 'Oi Celular, promo hoje!' } })]);
  });

  it('quando envia WhatsApp, então usa o template aprovado com os parâmetros preenchidos (fixo também pode ter WhatsApp)', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    await createLead(t.app, s, { name: 'Ana Souza', company: 'Atacado Norte', phone: '11 98888-3333' });
    await createLead(t.app, s, { name: 'Loja Fixa', phone: '1133334444' });
    const c = await newCampaign(s, { channel: 'whatsapp', name: 'Promo WA', content: { template: 'promo_novembro', language: 'pt_BR', params: ['{{primeiro_nome}}', '{{empresa}}'] } });
    await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`);
    await drainJobs(t.deps);
    const ana = t.messaging.sent.find((m) => m.to === '5511988883333')!.payload;
    expect(ana).toEqual({ to: '5511988883333', template: 'promo_novembro', language: 'pt_BR', params: ['Ana', 'Atacado Norte'] });
    expect(t.messaging.sent).toHaveLength(2);
  });

  it('quando o template do WhatsApp tem nome inválido ou o SMS passa de 480 caracteres, então 400', async () => {
    const s = await signup(t.app);
    expect((await call(t.app, s, 'POST', '/api/campaigns', { channel: 'whatsapp', name: 'x', content: { template: 'Promo Novembro!' } })).statusCode).toBe(400);
    expect((await call(t.app, s, 'POST', '/api/campaigns', { channel: 'sms', name: 'x', content: { text: 'a'.repeat(481) } })).statusCode).toBe(400);
  });

  it('calcula segmentos de SMS (acentos como ã/õ/ê viram UCS-2, 70 por SMS)', () => {
    expect(smsSegments('Oi, tudo bem? Promo hoje.')).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    expect(smsSegments('a'.repeat(161))).toMatchObject({ encoding: 'GSM-7', segments: 2 });
    expect(smsSegments('Promoção de verão')).toMatchObject({ encoding: 'UCS-2', segments: 1 });
    expect(smsSegments('ã'.repeat(71))).toMatchObject({ encoding: 'UCS-2', segments: 2 });
  });

  it('normaliza telefones brasileiros', () => {
    expect(normalizeBrPhone('(11) 98888-0000')).toBe('5511988880000');
    expect(normalizeBrPhone('+55 (21) 3333-4444')).toBe('552133334444');
    expect(normalizeBrPhone('0055 11 98888 0000')).toBe('5511988880000');
    for (const bad of ['1234', '(11) 18888-0000', '(00) 98888-0000', '(11) 1333-4444', '']) expect(normalizeBrPhone(bad), bad).toBeNull();
  });
});

describe('Ciclo de vida e permissões', () => {
  it('quando o canal não está conectado, então enviar responde 422 e a campanha continua rascunho', async () => {
    const s = await signup(t.app);
    await createLead(t.app, s, { email: 'a@x.com' });
    const c = await newCampaign(s, emailCampaign());
    const r = await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`);
    expect([r.statusCode, r.json().error]).toEqual([422, 'channel_not_configured']);
    expect((await call(t.app, s, 'GET', `/api/campaigns/${c.id}`)).json().status).toBe('draft');
  });

  it('quando ninguém é alcançável, então 422 e continua rascunho', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    const c = await newCampaign(s, emailCampaign());
    expect((await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`)).json().error).toBe('no_recipients');
    expect((await call(t.app, s, 'GET', `/api/campaigns/${c.id}`)).json().status).toBe('draft');
  });

  it('quando agenda para o futuro e cancela, então ninguém recebe, mesmo se o job rodar depois', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    await createLead(t.app, s, { email: 'a@x.com' });
    const c = await newCampaign(s, emailCampaign({ scheduledAt: new Date(Date.now() + 86400000).toISOString() }));
    const r = (await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`)).json();
    expect(r.scheduledAt).toBeTruthy();
    await drainJobs(t.deps); // job é do futuro: não roda agora
    expect(t.messaging.sent).toHaveLength(0);
    expect((await call(t.app, s, 'POST', `/api/campaigns/${c.id}/cancel`)).statusCode).toBe(200);
    await dispatchCampaign(t.deps, c.id, 0);
    expect(t.messaging.sent).toHaveLength(0);
    const d = (await call(t.app, s, 'GET', `/api/campaigns/${c.id}`)).json();
    expect([d.status, d.stats.skipped]).toEqual(['canceled', 1]);
  });

  it('quando a campanha já foi enviada, então não pode ser editada nem excluída; rascunho pode', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    await createLead(t.app, s, { email: 'a@x.com' });
    const draft = await newCampaign(s, emailCampaign({ name: 'Rascunho' }));
    expect((await call(t.app, s, 'PATCH', `/api/campaigns/${draft.id}`, { name: 'Novo nome' })).json().name).toBe('Novo nome');
    const c = await newCampaign(s, emailCampaign());
    await call(t.app, s, 'POST', `/api/campaigns/${c.id}/send`);
    expect((await call(t.app, s, 'PATCH', `/api/campaigns/${c.id}`, { name: 'x' })).statusCode).toBe(409);
    expect((await call(t.app, s, 'DELETE', `/api/campaigns/${c.id}`)).statusCode).toBe(409);
    expect((await call(t.app, s, 'DELETE', `/api/campaigns/${draft.id}`)).statusCode).toBe(200);
  });

  it('quando filtra o público por etapa e MQL, então só esses leads entram', async () => {
    const s = await signup(t.app);
    await connectAll(s);
    const st = await stages(t.app, s);
    const l1 = await createLead(t.app, s, { name: 'Qualificado', email: 'q@x.com', company: 'Q', phone: '11999990000', channel: 'indicacao', valueCents: 6_000_000 });
    await call(t.app, s, 'POST', `/api/leads/${l1.id}/move`, { stageId: st[1].id });
    await createLead(t.app, s, { name: 'Novo', email: 'n@x.com' });
    const r = (await call(t.app, s, 'POST', '/api/campaigns/audience-preview', { channel: 'email', audience: { stageIds: [st[1].id], mqlOnly: true } })).json();
    expect([r.matched, r.sample.map((x: any) => x.address)]).toEqual([1, ['q@x.com']]);
  });

  it('quando a empresa B tenta ver, enviar ou cancelar campanha da empresa A, então 404; vendedor não acessa campanhas', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const seller = await addMember(t.app, a, 'seller');
    await connectAll(a);
    await connectAll(b);
    await createLead(t.app, a, { email: 'a@x.com' });
    const c = await newCampaign(a, emailCampaign());
    expect((await call(t.app, b, 'GET', `/api/campaigns/${c.id}`)).statusCode).toBe(404);
    expect((await call(t.app, b, 'POST', `/api/campaigns/${c.id}/send`)).statusCode).toBe(404);
    expect((await call(t.app, b, 'GET', '/api/campaigns')).json()).toEqual([]);
    expect((await call(t.app, seller, 'GET', '/api/campaigns')).statusCode).toBe(403);
    expect((await call(t.app, seller, 'POST', `/api/campaigns/${c.id}/send`)).statusCode).toBe(403);
  });
});
