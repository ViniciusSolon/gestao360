import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, call, createLead, createProduct, createTestApp, resetDb, signup, type TestCtx } from './helpers.js';
import { cnpjCheckDigits, formatCnpj, isValidCnpj, normalizeCnpj } from '../src/lib/cnpj.js';

describe('CNPJ — validação (numérico e alfanumérico)', () => {
  it('aceita CNPJs numéricos reais, com e sem máscara', () => {
    for (const c of ['11.222.333/0001-81', '11222333000181', '33.000.167/0001-01', '00.360.305/0001-04']) expect(isValidCnpj(c), c).toBe(true);
  });

  it('aceita o CNPJ alfanumérico do exemplo da Receita (12.ABC.345/01DE-35), inclusive em minúsculas', () => {
    expect(cnpjCheckDigits('12ABC34501DE')).toBe('35');
    expect(isValidCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(isValidCnpj('12abc34501de35')).toBe(true);
  });

  it('recusa dígito verificador errado, tamanho errado, letra no DV e sequência repetida', () => {
    for (const c of ['11.222.333/0001-80', '12.ABC.345/01DE-34', '1122233300018', '12ABC34501DE3A', '00.000.000/0000-00', '11111111111111', '']) {
      expect(isValidCnpj(c), c).toBe(false);
    }
  });

  it('normaliza e formata', () => {
    expect(normalizeCnpj(' 12.abc.345/01de-35 ')).toBe('12ABC34501DE35');
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatCnpj('12abc34501de35')).toBe('12.ABC.345/01DE-35');
  });
});

describe('CNPJ no lead (rotas)', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t.app.close(); await t.db.close(); });
  beforeEach(async () => { await resetDb(t.db); });

  it('quando cria lead com CNPJ mascarado, então grava só os caracteres e devolve na listagem do Kanban', async () => {
    const s = await signup(t.app);
    const lead = await createLead(t.app, s, { cnpj: '11.222.333/0001-81' });
    expect(lead.cnpj).toBe('11222333000181');
    const list = (await call(t.app, s, 'GET', '/api/leads')).json();
    expect(list[0].cnpj).toBe('11222333000181');
  });

  it('quando o CNPJ é alfanumérico válido, então aceita e guarda em maiúsculas', async () => {
    const s = await signup(t.app);
    expect((await createLead(t.app, s, { cnpj: '12.abc.345/01de-35' })).cnpj).toBe('12ABC34501DE35');
  });

  it('quando o CNPJ tem dígito verificador errado, então 400 e nada é criado', async () => {
    const s = await signup(t.app);
    const r = await call(t.app, s, 'POST', '/api/leads', { name: 'X', cnpj: '11.222.333/0001-80' });
    expect(r.statusCode).toBe(400);
    expect(r.json().issues[0].message).toMatch(/CNPJ inválido/);
    expect((await call(t.app, s, 'GET', '/api/leads')).json()).toHaveLength(0);
  });

  it('quando o CNPJ vem vazio, então o lead fica sem CNPJ (campo opcional)', async () => {
    const s = await signup(t.app);
    expect((await createLead(t.app, s, { cnpj: '' })).cnpj).toBeNull();
    expect((await createLead(t.app, s)).cnpj).toBeNull();
  });

  it('quando busca pelo CNPJ com ou sem máscara (ou por parte dele), então encontra o lead', async () => {
    const s = await signup(t.app);
    await createLead(t.app, s, { name: 'Com CNPJ', cnpj: '33.000.167/0001-01' });
    await createLead(t.app, s, { name: 'Outro', cnpj: '11.222.333/0001-81' });
    // (trechos que só existem no CNPJ esperado; "330001" também casaria com 11222333000181)
    for (const q of ['33.000.167/0001-01', '33000167000101', '33.000.167', '000167']) {
      const r = (await call(t.app, s, 'GET', `/api/leads?q=${encodeURIComponent(q)}`)).json();
      expect(r.map((l: any) => l.name), q).toEqual(['Com CNPJ']);
    }
    // busca por nome continua funcionando
    expect((await call(t.app, s, 'GET', '/api/leads?q=Outro')).json()).toHaveLength(1);
  });

  it('quando edita o lead, então troca ou remove o CNPJ; CNPJ inválido na edição é recusado', async () => {
    const s = await signup(t.app);
    const lead = await createLead(t.app, s, { cnpj: '11222333000181' });
    expect((await call(t.app, s, 'PATCH', `/api/leads/${lead.id}`, { cnpj: '33.000.167/0001-01' })).json().cnpj).toBe('33000167000101');
    expect((await call(t.app, s, 'PATCH', `/api/leads/${lead.id}`, { cnpj: '123' })).statusCode).toBe(400);
    expect((await call(t.app, s, 'PATCH', `/api/leads/${lead.id}`, { valueCents: 5 })).json().cnpj).toBe('33000167000101'); // mantém
    expect((await call(t.app, s, 'PATCH', `/api/leads/${lead.id}`, { cnpj: null })).json().cnpj).toBeNull();
  });

  it('quando a mesma empresa tem duas oportunidades, então o mesmo CNPJ pode aparecer em dois leads', async () => {
    const s = await signup(t.app);
    await createLead(t.app, s, { name: 'Oportunidade 1', cnpj: '11222333000181' });
    await createLead(t.app, s, { name: 'Oportunidade 2', cnpj: '11.222.333/0001-81' });
    expect((await call(t.app, s, 'GET', '/api/leads?q=11222333000181')).json()).toHaveLength(2);
  });

  it('quando o vendedor busca por CNPJ, então só encontra os próprios leads', async () => {
    const owner = await signup(t.app);
    const seller = await addMember(t.app, owner, 'seller');
    await createLead(t.app, owner, { ownerId: owner.userId, cnpj: '11222333000181' });
    expect((await call(t.app, seller, 'GET', '/api/leads?q=11222333000181')).json()).toHaveLength(0);
  });

  it('quando o banco recebe CNPJ fora do formato direto (sem passar pela API), então o CHECK recusa', async () => {
    const s = await signup(t.app);
    const lead = await createLead(t.app, s);
    await expect(t.db.platform.query(`UPDATE leads SET cnpj = '11.222.333/0001-81' WHERE id = $1`, [lead.id])).rejects.toThrow(/check/i);
  });

  it('quando gera o PDF da proposta, então o CNPJ formatado aparece', async () => {
    const s = await signup(t.app);
    const lead = await createLead(t.app, s, { cnpj: '11222333000181' });
    const prod = await createProduct(t.app, s);
    const p = (await call(t.app, s, 'POST', '/api/proposals', { leadId: lead.id, items: [{ productId: prod.id, quantity: 1 }] }, { 'idempotency-key': 'cnpj-pdf-0001' })).json();
    const pdf = (await call(t.app, s, 'GET', `/api/proposals/${p.id}/pdf`)).rawPayload;
    // As páginas vêm comprimidas (Flate) e o pdfkit escreve o texto em hexadecimal: descomprime e procura
    const raw = pdf.toString('latin1');
    const pages: string[] = [];
    for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      try { pages.push(inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1')); } catch { /* fonte/imagem */ }
    }
    // Cada linha é um array TJ com pedaços <hex> separados por ajustes de kerning: junta e decodifica
    const lines = [...pages.join('\n').matchAll(/\[([^\]]*)\]\s*TJ/g)].map((m) =>
      [...m[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join(''),
    );
    expect(lines).toContain('CNPJ: 11.222.333/0001-81');
  });
});
