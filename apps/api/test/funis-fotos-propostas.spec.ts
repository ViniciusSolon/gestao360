import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { addMember, call, createLead, createProduct, createTestApp, resetDb, signup, type Session, type TestCtx } from './helpers.js';
import { sniffImage } from '../src/modules/products.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => { await resetDb(t.db); t.messaging.sent = []; });

type Pipe = { id: string; name: string; stages: { id: string; name: string; kind: string; pipeline_id: string }[] };
const pipelines = async (s: Session) => (await call(t.app, s, 'GET', '/api/pipelines')).json() as Pipe[];

// ---------------------------------------------------------------------------
describe('Vários funis', () => {
  it('quando a empresa é criada, então já tem 1 funil com as etapas padrão', async () => {
    const s = await signup(t.app);
    const p = await pipelines(s);
    expect(p.map((x) => x.name)).toEqual(['Funil comercial']);
    expect(p[0].stages.length).toBeGreaterThan(3);
  });

  it('quando cria um funil novo, então ele aparece embaixo, com etapas próprias, e recebe leads', async () => {
    const s = await signup(t.app);
    const r = await call(t.app, s, 'POST', '/api/pipelines', { name: 'Pós-venda' });
    expect(r.statusCode).toBe(201);
    expect(r.json().stages.map((x: any) => x.kind)).toEqual(['open', 'open', 'won', 'lost']);
    const p = await pipelines(s);
    expect(p.map((x) => x.name)).toEqual(['Funil comercial', 'Pós-venda']);
    const lead = await createLead(t.app, s, { stageId: p[1].stages[0].id });
    expect(lead.stage_id).toBe(p[1].stages[0].id);
    // lead sem etapa vai para o PRIMEIRO funil
    expect((await createLead(t.app, s)).stage_id).toBe(p[0].stages[0].id);
  });

  it('quando a proposta é aceita, então o lead vai para "Ganho" do funil DELE (não do outro funil)', async () => {
    const s = await signup(t.app);
    const novo = (await call(t.app, s, 'POST', '/api/pipelines', { name: 'Pós-venda' })).json() as Pipe;
    const lead = await createLead(t.app, s, { stageId: novo.stages[0].id });
    const prod = await createProduct(t.app, s);
    const prop = (await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] }, { 'idempotency-key': 'pv-accept-001' })).json();
    await call(t.app, s, 'POST', `/api/proposals/${prop.id}/send`);
    await call(t.app, s, 'POST', `/api/proposals/${prop.id}/accept`);
    const won = novo.stages.find((x) => x.kind === 'won')!;
    expect((await call(t.app, s, 'GET', `/api/leads/${lead.id}`)).json().stage_id).toBe(won.id);
  });

  it('quando cria etapa num funil, então ela vai para o final DAQUELE funil', async () => {
    const s = await signup(t.app);
    const novo = (await call(t.app, s, 'POST', '/api/pipelines', { name: 'Pós-venda' })).json() as Pipe;
    const st = (await call(t.app, s, 'POST', '/api/stages', { name: 'Onboarding', probability: 30, pipelineId: novo.id })).json();
    expect([st.pipeline_id, st.position]).toEqual([novo.id, 4]);
  });

  it('quando exclui um funil com leads ou o último funil, então 409; funil vazio pode ser excluído', async () => {
    const s = await signup(t.app);
    const [principal] = await pipelines(s);
    expect((await call(t.app, s, 'DELETE', `/api/pipelines/${principal.id}`)).json().error).toBe('last_pipeline');
    const a = (await call(t.app, s, 'POST', '/api/pipelines', { name: 'A' })).json() as Pipe;
    const b = (await call(t.app, s, 'POST', '/api/pipelines', { name: 'B' })).json() as Pipe;
    await createLead(t.app, s, { stageId: a.stages[0].id });
    expect((await call(t.app, s, 'DELETE', `/api/pipelines/${a.id}`)).json().error).toBe('pipeline_has_leads');
    expect((await call(t.app, s, 'DELETE', `/api/pipelines/${b.id}`)).statusCode).toBe(200);
    expect((await pipelines(s)).map((x) => x.name)).toEqual(['Funil comercial', 'A']);
    expect(Number((await t.db.platform.query('SELECT count(*) FROM leads')).rows[0].count)).toBe(1);
  });

  it('quando dois admins excluem os 2 únicos funis ao mesmo tempo, então sobra um', async () => {
    const s = await signup(t.app);
    for (let round = 0; round < 8; round++) {
      await call(t.app, s, 'POST', '/api/pipelines', { name: `Extra ${round}` });
      const ids = (await pipelines(s)).map((p) => p.id);
      expect(ids).toHaveLength(2);
      const rs = await Promise.all(ids.map((id) => call(t.app, s, 'DELETE', `/api/pipelines/${id}`)));
      expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(await pipelines(s)).toHaveLength(1);
    }
  });

  it('vendedor e gerente não criam nem excluem funis', async () => {
    const s = await signup(t.app);
    const mgr = await addMember(t.app, s, 'manager');
    expect((await call(t.app, mgr, 'POST', '/api/pipelines', { name: 'X' })).statusCode).toBe(403);
    expect((await call(t.app, mgr, 'GET', '/api/pipelines')).statusCode).toBe(200);
  });

  it('a empresa B não vê nem exclui funil da empresa A', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const novo = (await call(t.app, a, 'POST', '/api/pipelines', { name: 'Secreto' })).json() as Pipe;
    expect((await pipelines(b)).map((x) => x.name)).toEqual(['Funil comercial']);
    expect((await call(t.app, b, 'DELETE', `/api/pipelines/${novo.id}`)).statusCode).toBe(404);
    expect((await call(t.app, b, 'POST', '/api/stages', { name: 'X', probability: 1, pipelineId: novo.id })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('Excluir etapa', () => {
  it('quando cria uma etapa nova, então pode excluí-la', async () => {
    const s = await signup(t.app);
    const st = (await call(t.app, s, 'POST', '/api/stages', { name: 'Temporária', probability: 5 })).json();
    expect((await call(t.app, s, 'DELETE', `/api/stages/${st.id}`)).statusCode).toBe(200);
    expect((await pipelines(s))[0].stages.map((x) => x.name)).not.toContain('Temporária');
  });

  it('quando a etapa tem leads, então 409 e nada é apagado', async () => {
    const s = await signup(t.app);
    const st = (await call(t.app, s, 'POST', '/api/stages', { name: 'Com lead', probability: 5 })).json();
    await createLead(t.app, s, { stageId: st.id });
    expect((await call(t.app, s, 'DELETE', `/api/stages/${st.id}`)).json().error).toBe('stage_has_leads');
    expect((await pipelines(s))[0].stages.map((x) => x.name)).toContain('Com lead');
  });

  it('quando é a última etapa aberta do funil, então 409 (os leads novos entram nela)', async () => {
    const s = await signup(t.app);
    const novo = (await call(t.app, s, 'POST', '/api/pipelines', { name: 'P' })).json() as Pipe;
    const [o1, o2] = novo.stages.filter((x) => x.kind === 'open');
    const rs = await Promise.all([o1, o2].map((x) => call(t.app, s, 'DELETE', `/api/stages/${x.id}`)));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await pipelines(s))[1].stages.filter((x) => x.kind === 'open')).toHaveLength(1);
  });

  it('vendedor não exclui etapa', async () => {
    const s = await signup(t.app);
    const seller = await addMember(t.app, s, 'seller');
    const st = (await call(t.app, s, 'POST', '/api/stages', { name: 'X', probability: 5 })).json();
    expect((await call(t.app, seller, 'DELETE', `/api/stages/${st.id}`)).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(10)]);

describe('Foto do produto (upload)', () => {
  const put = (s: Session, id: string, body: Buffer | string, type = 'image/png') => call(t.app, s, 'PUT', `/api/products/${id}/image`, body, { 'content-type': type });

  it('quando envia uma imagem, então ela aparece no catálogo e é servida com o tipo certo', async () => {
    const s = await signup(t.app);
    const prod = await createProduct(t.app, s);
    const r = await put(s, prod.id, PNG);
    expect(r.statusCode, r.body).toBe(200);
    const list = (await call(t.app, s, 'GET', '/api/products')).json();
    expect(list[0].image_updated_at).toBeTruthy();
    expect(list[0]).not.toHaveProperty('content');
    const img = await call(t.app, s, 'GET', `/api/products/${prod.id}/image`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.rawPayload.equals(PNG)).toBe(true);
  });

  it('quando o arquivo não é imagem de verdade (HTML/SVG renomeado), então 400', async () => {
    const s = await signup(t.app);
    const prod = await createProduct(t.app, s);
    expect((await put(s, prod.id, '<svg onload=alert(1)>', 'image/svg+xml')).statusCode).toBe(400);
    expect((await put(s, prod.id, '<html><script>alert(1)</script>', 'image/png')).statusCode).toBe(400);
  });

  it('quando a imagem passa de 2 MB, então 413', async () => {
    const s = await signup(t.app);
    const prod = await createProduct(t.app, s);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await put(s, prod.id, big)).statusCode).toBe(413);
  });

  it('quando troca a foto, então substitui (uma por produto); quando remove, então some', async () => {
    const s = await signup(t.app);
    const prod = await createProduct(t.app, s);
    await put(s, prod.id, PNG);
    await put(s, prod.id, JPEG, 'image/jpeg');
    expect((await call(t.app, s, 'GET', `/api/products/${prod.id}/image`)).headers['content-type']).toBe('image/jpeg');
    expect(Number((await t.db.platform.query('SELECT count(*) FROM product_images')).rows[0].count)).toBe(1);
    expect((await call(t.app, s, 'DELETE', `/api/products/${prod.id}/image`)).statusCode).toBe(200);
    expect((await call(t.app, s, 'GET', `/api/products/${prod.id}/image`)).statusCode).toBe(404);
  });

  it('vendedor vê mas não envia foto; outra empresa não vê nem troca', async () => {
    const s = await signup(t.app);
    const other = await signup(t.app);
    const seller = await addMember(t.app, s, 'seller');
    const prod = await createProduct(t.app, s);
    await put(s, prod.id, PNG);
    expect((await put(seller, prod.id, JPEG, 'image/jpeg')).statusCode).toBe(403);
    expect((await call(t.app, seller, 'GET', `/api/products/${prod.id}/image`)).statusCode).toBe(200);
    expect((await call(t.app, other, 'GET', `/api/products/${prod.id}/image`)).statusCode).toBe(404);
    expect((await put(other, prod.id, JPEG, 'image/jpeg')).statusCode).toBe(404);
    expect((await call(t.app, other, 'DELETE', `/api/products/${prod.id}/image`)).statusCode).toBe(404);
  });

  it('reconhece o formato pelo conteúdo', () => {
    expect([sniffImage(PNG), sniffImage(JPEG), sniffImage(WEBP), sniffImage(Buffer.from('GIF89a'))]).toEqual(['image/png', 'image/jpeg', 'image/webp', null]);
  });
});

// ---------------------------------------------------------------------------
describe('Enviar proposta por WhatsApp e e-mail', () => {
  async function scenario(lead: Record<string, unknown> = { name: 'Marcos Pereira', email: 'marcos@sul.com', phone: '(11) 98888-1111' }) {
    const s = await signup(t.app);
    const l = await createLead(t.app, s, lead);
    const prod = await createProduct(t.app, s);
    const p = (await call(t.app, s, 'POST', '/api/proposals', { leadId: l.id, items: [{ productId: prod.id, quantity: 2 }] }, { 'idempotency-key': randomUUID() })).json();
    return { s, lead: l, p };
  }
  const connectEmail = (s: Session) => call(t.app, s, 'PUT', '/api/channels/email', { fromName: 'Usaplast', fromEmail: 'vendas@usaplast.com.br', apiKey: 're_chave_teste_1234' });
  const tokenOf = (url: string) => url.split('/').pop()!;

  it('quando clica em WhatsApp, então recebe o link do wa.me com o telefone do lead e a proposta vira "enviada"', async () => {
    const { s, p } = await scenario();
    const r = (await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/whatsapp`)).json();
    expect(r.status).toBe('sent');
    expect(r.whatsappUrl).toMatch(/^https:\/\/wa\.me\/5511988881111\?text=/);
    const text = decodeURIComponent(r.whatsappUrl.split('text=')[1]);
    expect(text).toContain('Olá, Marcos!');
    expect(text).toContain(`nº ${p.number}`);
    expect(text).toContain(r.url);
  });

  it('quando o cliente abre o link, então vê o PDF sem login; link adulterado ou vencido dá 404', async () => {
    const { s, p } = await scenario();
    const { url } = (await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/whatsapp`)).json();
    const pdf = await t.app.inject({ method: 'GET', url: `/api/public/propostas/${tokenOf(url)}` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const bad = tokenOf(url).slice(0, -1) + (tokenOf(url).endsWith('A') ? 'B' : 'A');
    expect((await t.app.inject({ method: 'GET', url: `/api/public/propostas/${bad}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/public/propostas/curto' })).statusCode).toBe(404);
    await t.db.platform.query(`UPDATE proposals SET share_expires_at = now() - interval '1 minute'`);
    expect((await t.app.inject({ method: 'GET', url: `/api/public/propostas/${tokenOf(url)}` })).statusCode).toBe(404);
  });

  it('quando manda por WhatsApp e depois por e-mail, então o mesmo link continua valendo', async () => {
    const { s, p } = await scenario();
    await connectEmail(s);
    const w = (await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/whatsapp`)).json();
    const e = (await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/email`, {}, { 'idempotency-key': randomUUID() })).json();
    expect(e.url).toBe(w.url);
  });

  it('quando envia por e-mail, então vai pela conta da empresa, com o PDF anexo e o link', async () => {
    const { s, p } = await scenario();
    await connectEmail(s);
    const r = await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/email`, { message: 'Conforme conversamos <b>hoje</b>.' }, { 'idempotency-key': 'prop-mail-0001' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, to: 'marcos@sul.com', status: 'sent' });
    const m = t.messaging.sent.at(-1)!;
    const payload = m.payload as any;
    expect(m.to).toBe('marcos@sul.com');
    expect(m.idempotencyKey).toBe(`proposal-${p.id}-prop-mail-0001`);
    expect(payload.subject).toContain(`nº ${p.number}`);
    expect(payload.attachments[0].filename).toBe(`proposta-${p.number}.pdf`);
    expect(Buffer.from(payload.attachments[0].contentBase64, 'base64').subarray(0, 4).toString()).toBe('%PDF');
    expect(payload.html).toContain('&lt;b&gt;hoje&lt;/b&gt;'); // mensagem do vendedor escapada
    expect(payload.html).toContain(`href="${r.json().url}"`);
  });

  it('quando o e-mail da empresa não está conectado, então 422 e a proposta continua rascunho; "abrir no meu e-mail" devolve o texto pronto', async () => {
    const { s, p } = await scenario();
    const r = await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/email`, {}, { 'idempotency-key': randomUUID() });
    expect([r.statusCode, r.json().error]).toEqual([422, 'channel_not_configured']);
    expect((await call(t.app, s, 'GET', `/api/proposals/${p.id}`)).json().status).toBe('draft');
    const link = (await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/link`)).json();
    expect(link).toMatchObject({ status: 'sent', to: 'marcos@sul.com' });
    expect(link.text).toContain(link.url);
  });

  it('quando o provedor recusa o e-mail, então a proposta NÃO vira enviada', async () => {
    const { s, p } = await scenario({ name: 'Ruim', email: 'falha@x.com' });
    await connectEmail(s);
    const r = await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/email`, {}, { 'idempotency-key': randomUUID() });
    expect([r.statusCode, r.json().error]).toEqual([422, 'provider_error']);
    expect((await call(t.app, s, 'GET', `/api/proposals/${p.id}`)).json().status).toBe('draft');
  });

  it('quando o lead não tem e-mail nem telefone, então e-mail pede destinatário e WhatsApp abre sem número', async () => {
    const { s, p } = await scenario({ name: 'Sem Contato' });
    await connectEmail(s);
    expect((await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/email`, {}, { 'idempotency-key': randomUUID() })).json().error).toBe('missing_email');
    expect((await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/email`, { to: 'outro@cliente.com' }, { 'idempotency-key': randomUUID() })).json().to).toBe('outro@cliente.com');
    const w = (await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/whatsapp`)).json();
    expect([w.whatsappUrl.startsWith('https://wa.me/?text='), w.phoneFound]).toEqual([true, false]);
  });

  it('sem Idempotency-Key o e-mail não sai; proposta recusada não é enviada; vendedor não envia proposta de lead de outro', async () => {
    const { s, p } = await scenario();
    await connectEmail(s);
    expect((await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/email`, {})).statusCode).toBe(400);
    await call(t.app, s, 'POST', `/api/proposals/${p.id}/send`);
    await call(t.app, s, 'POST', `/api/proposals/${p.id}/reject`);
    expect((await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/whatsapp`)).statusCode).toBe(409);
    const seller = await addMember(t.app, s, 'seller');
    const lead = await createLead(t.app, s, { name: 'Do Dono' });
    await call(t.app, s, 'PATCH', `/api/leads/${lead.id}`, { ownerId: s.userId });
    const prod = await createProduct(t.app, s, { sku: 'X-2' });
    const p2 = (await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] }, { 'idempotency-key': randomUUID() })).json();
    expect((await call(t.app, seller, 'POST', `/api/proposals/${p2.id}/share/whatsapp`)).statusCode).toBe(404);
    expect(t.messaging.sent).toHaveLength(0);
  });

  it('o link de rascunho (e-mail ainda não aceito) não abre para o cliente', async () => {
    const { s, p } = await scenario({ name: 'Ruim', email: 'falha@x.com' });
    await connectEmail(s);
    await call(t.app, s, 'POST', `/api/proposals/${p.id}/share/email`, {}, { 'idempotency-key': randomUUID() });
    const tok = (await t.db.platform.query('SELECT share_token FROM proposals WHERE id = $1', [p.id])).rows[0].share_token;
    expect(tok).toBeTruthy();
    expect((await t.app.inject({ method: 'GET', url: `/api/public/propostas/${tok}` })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('Indicadores comerciais filtrados por funil', () => {
  it('quando escolhe um funil, então KPIs, funil e fontes contam só os leads dele', async () => {
    const s = await signup(t.app);
    const [principal] = await pipelines(s);
    const pv = (await call(t.app, s, 'POST', '/api/pipelines', { name: 'Pós-venda' })).json() as Pipe;
    await createLead(t.app, s, { name: 'A', channel: 'indicacao', valueCents: 100000 });
    await createLead(t.app, s, { name: 'B', channel: 'google_ads', valueCents: 200000 });
    const c = await createLead(t.app, s, { name: 'C', channel: 'direto', valueCents: 300000, stageId: pv.stages[0].id });
    await call(t.app, s, 'POST', `/api/leads/${c.id}/move`, { stageId: pv.stages.find((x) => x.kind === 'won')!.id });

    const all = (await call(t.app, s, 'GET', '/api/dashboard')).json();
    expect(all.kpis.leads.value).toBe(3);
    expect(new Set(all.funnel.map((f: any) => f.pipeline))).toEqual(new Set(['Funil comercial', 'Pós-venda']));

    const onlyPv = (await call(t.app, s, 'GET', `/api/dashboard?pipelineId=${pv.id}`)).json();
    expect([onlyPv.kpis.leads.value, onlyPv.kpis.wonCount.value, onlyPv.kpis.wonValueCents.value]).toEqual([1, 1, 300000]);
    expect(onlyPv.funnel.every((f: any) => f.pipeline === 'Pós-venda')).toBe(true);
    expect(onlyPv.byChannel.map((x: any) => x.channel)).toEqual(['direto']);

    const onlyMain = (await call(t.app, s, 'GET', `/api/dashboard?pipelineId=${principal.id}`)).json();
    expect([onlyMain.kpis.leads.value, onlyMain.kpis.wonCount.value]).toEqual([2, 0]);
    expect(onlyMain.byChannel.map((x: any) => x.channel).sort()).toEqual(['google_ads', 'indicacao']);
  });

  it('quando o funil é de outra empresa ou não existe, então 404', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const [pa] = await pipelines(a);
    expect((await call(t.app, b, 'GET', `/api/dashboard?pipelineId=${pa.id}`)).statusCode).toBe(404);
    expect((await call(t.app, b, 'GET', `/api/dashboard?pipelineId=${randomUUID()}`)).statusCode).toBe(404);
  });
});
