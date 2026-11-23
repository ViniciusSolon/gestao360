// Cria uma empresa de demonstração e captura as telas do Gestão 360° para o guia rápido.
// Uso (API e web rodando em localhost:5173):
//   CAPTURE_SECRETS_DIR=<pasta com admin_pw e admin_mfa.txt> node docs/guia/capturar_telas.cjs docs/guia/img
// admin_pw: senha do admin da plataforma; admin_mfa.txt: saída do platform:create-admin (com a "chave manual").
const { chromium, request } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

const OUT = process.argv[2];
const SCR = process.env.CAPTURE_SECRETS_DIR;
if (!SCR) { console.error('Defina CAPTURE_SECRETS_DIR'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const B = 'http://localhost:5173';
const id = Date.now().toString(36).slice(-5);
const adminPw = fs.readFileSync(`${SCR}/admin_pw`, 'utf8').trim();
const b32 = fs.readFileSync(`${SCR}/admin_mfa.txt`, 'utf8').match(/chave manual: ([A-Z2-7]+)/)[1];

function totpNow() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out = [];
  for (const ch of b32) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(out)).update(msg).digest(); const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const shot = async (name, opts = {}) => { await page.waitForTimeout(350); await page.screenshot({ path: `${OUT}/${name}.png`, ...opts }); };
  const api = async (method, url, data, headers = {}) => {
    const r = await page.request.fetch(`${B}/api${url}`, { method, data, headers });
    if (!r.ok()) throw new Error(`${method} ${url} → ${r.status()} ${await r.text()}`);
    return r.json();
  };

  // 1) Cadastro
  await page.goto(`${B}/cadastro`);
  await page.getByLabel('Empresa').fill('Distribuidora Aurora');
  await page.getByLabel('Identificador (URL)').fill(`aurora-${id}`);
  await page.getByLabel('Seu nome').fill('Ana Souza');
  await page.getByLabel('E-mail').fill(`ana.${id}@aurora.com.br`);
  await page.getByLabel('Senha').fill('senha-forte-123');
  await shot('01-cadastro');
  await page.getByRole('button', { name: /Criar conta/ }).click();
  await page.waitForURL(`${B}/app`);

  // Dados de demonstração (pela própria API, como um usuário faria)
  const products = {};
  for (const [sku, name, price, ncm, tax] of [
    ['PAR-001', 'Parafusadeira industrial', 125000, '84672100', 1200],
    ['COM-220', 'Compressor de ar 220V', 389000, '84143000', 1500],
    ['EPI-010', 'Kit EPI completo', 28990, '62101000', 800],
    ['LUB-005', 'Lubrificante industrial 5L', 15900, '27101932', 1800],
  ]) products[sku] = await api('POST', '/products', { sku, name, priceCents: price, ncm, taxRateBp: tax });

  const inv = await api('POST', '/invites', { email: `lucas.${id}@aurora.com.br`, role: 'seller' });
  const sellerCtx = await request.newContext({ baseURL: B });
  const acc = await sellerCtx.post('/api/auth/accept-invite', { data: { token: new URL(inv.url).searchParams.get('token'), name: 'Lucas Oliveira', password: 'senha-forte-123' } });
  if (!acc.ok()) throw new Error('aceite falhou');
  const users = await api('GET', '/users');
  const seller = users.find((u) => u.role === 'seller');
  await api('POST', '/invites', { email: `marina.${id}@aurora.com.br`, role: 'manager' }); // convite pendente na tela de Equipe

  const st = await api('GET', '/stages');
  const stage = (n) => st.find((s) => s.name === n).id;
  const L = {};
  for (const [key, name, company, channel, value, owner] of [
    ['marcos', 'Marcos Pereira', 'Metalúrgica Sul', 'indicacao', 4800000, null],
    ['juliana', 'Juliana Costa', 'Atacado Norte', 'site', 1550000, null],
    ['ricardo', 'Ricardo Alves', 'Construtora Prisma', 'evento', 8200000, seller.id],
    ['fernanda', 'Fernanda Lima', 'Ferragens Lima', 'whatsapp', 980000, null],
    ['paulo', 'Paulo Mendes', 'Indústria Vértice', 'indicacao', 3600000, null],
    ['carla', 'Carla Souza', 'Distribuidora Leste', 'email', 2200000, seller.id],
    ['bruno', 'Bruno Rocha', 'Agro Campos', 'telefone', 1200000, null],
    ['aline', 'Aline Martins', 'Loja Martins', 'redes_sociais', 650000, seller.id],
  ]) {
    L[key] = await api('POST', '/leads', {
      name, company, channel, valueCents: value, email: `${key}@${company.toLowerCase().replace(/[^a-z]/g, '')}.com.br`,
      phone: '(11) 98888-0000', ...(owner ? { ownerId: owner } : {}),
    });
  }
  await api('POST', `/leads/${L.marcos.id}/move`, { stageId: stage('Negociação') });
  await api('POST', `/leads/${L.juliana.id}/move`, { stageId: stage('Proposta enviada') });
  await api('POST', `/leads/${L.ricardo.id}/move`, { stageId: stage('Qualificado') });
  await api('POST', `/leads/${L.paulo.id}/move`, { stageId: stage('Proposta enviada') });
  await api('POST', `/leads/${L.carla.id}/move`, { stageId: stage('Ganho') });
  await api('POST', `/leads/${L.bruno.id}/move`, { stageId: stage('Perdido'), lostReason: 'Preço acima do concorrente' });

  const day = (d, h) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, 0, 0, 0); return x.toISOString(); };
  await api('POST', '/activities', { leadId: L.marcos.id, type: 'call', title: 'Ligar para negociar prazo de entrega', dueAt: day(1, 10) });
  await api('POST', '/activities', { leadId: L.juliana.id, type: 'meeting', title: 'Apresentação da proposta', dueAt: day(2, 15), meetingUrl: 'https://meet.google.com/abc-defg-hij' });
  await api('POST', '/activities', { leadId: L.ricardo.id, type: 'task', title: 'Enviar catálogo de compressores', dueAt: day(1, 9), assignedTo: seller.id });
  await api('POST', '/activities', { leadId: L.fernanda.id, type: 'call', title: 'Primeiro contato pelo WhatsApp', dueAt: day(-1, 11) });
  await api('POST', '/activities', { leadId: L.marcos.id, type: 'note', title: 'Cliente pediu desconto para 10 unidades' });

  const k = () => crypto.randomUUID();
  const pPaulo = await api('POST', '/proposals', {
    leadId: L.paulo.id, freightCents: 35000, paymentTerms: '30/60/90 dias', validUntil: day(15, 0).slice(0, 10),
    items: [{ productId: products['COM-220'].id, quantity: 6, discountPercent: 5 }, { productId: products['LUB-005'].id, quantity: 12, discountPercent: 0 }],
  }, { 'Idempotency-Key': k() });
  await api('POST', `/proposals/${pPaulo.id}/send`);
  await api('POST', `/proposals/${pPaulo.id}/accept`);
  const pJuliana = await api('POST', '/proposals', {
    leadId: L.juliana.id, freightCents: 18000, paymentTerms: '28 dias', validUntil: day(10, 0).slice(0, 10),
    items: [{ productId: products['EPI-010'].id, quantity: 40, discountPercent: 8 }, { productId: products['PAR-001'].id, quantity: 4, discountPercent: 5 }],
  }, { 'Idempotency-Key': k() });
  await api('POST', `/proposals/${pJuliana.id}/send`);
  await api('POST', '/proposals', {
    leadId: L.marcos.id, freightCents: 0, paymentTerms: 'À vista com 3% de desconto',
    items: [{ productId: products['PAR-001'].id, quantity: 10, discountPercent: 10 }],
  }, { 'Idempotency-Key': k() });

  // 2) Telas do app do cliente
  await page.goto(`${B}/app`); await page.getByText('Valor vendido').waitFor();
  await shot('02-indicadores', { fullPage: true });
  await page.goto(`${B}/app/funil`); await page.getByRole('link', { name: 'Marcos Pereira' }).waitFor();
  await page.locator('.kanban').evaluate((el) => (el.scrollLeft = 0));
  await shot('03-funil');
  await page.getByRole('button', { name: '+ Novo lead' }).click();
  await page.getByRole('textbox', { name: 'Nome*' }).fill('Roberto Nunes');
  await page.getByRole('textbox', { name: 'Empresa' }).fill('Usinagem Nunes');
  await page.getByRole('textbox', { name: 'E-mail' }).fill('roberto@usinagemnunes.com.br');
  await page.getByRole('textbox', { name: 'Telefone' }).fill('(19) 97777-1234');
  await page.getByLabel('Canal').selectOption('indicacao');
  await page.getByLabel('Valor estimado (R$)').fill('27.500,00');
  await shot('04-novo-lead');
  await page.getByRole('button', { name: 'Cancelar' }).click();

  await page.goto(`${B}/app/leads/${L.marcos.id}`); await page.getByText('Histórico').waitFor();
  await shot('05-lead', { fullPage: true });
  await page.goto(`${B}/app/agenda`); await page.locator('select').first().selectOption('true');
  await page.getByLabel('Só minhas').uncheck(); await page.waitForTimeout(500);
  await shot('06-agenda');
  await page.goto(`${B}/app/produtos`); await page.getByRole('cell', { name: 'Compressor de ar 220V' }).waitFor();
  await shot('07-produtos');

  await page.goto(`${B}/app/propostas/nova?leadId=${L.fernanda.id}`); await page.getByText('Nova proposta').waitFor();
  await page.waitForTimeout(500);
  await page.locator('select').nth(1).selectOption({ index: 2 });
  await page.getByLabel('Quantidade').fill('2');
  await page.getByLabel('Desconto (%)').fill('5');
  await page.getByLabel('Frete (R$)').fill('120,00');
  await page.getByLabel('Condições de pagamento').fill('30/60 dias');
  await shot('08-nova-proposta');
  await page.goto(`${B}/app/propostas`); await page.waitForTimeout(400);
  await shot('09-propostas');
  await page.goto(`${B}/app/propostas/${pJuliana.id}`); await page.getByText(`Proposta #${pJuliana.number}`).waitFor();
  await shot('10-proposta');
  fs.writeFileSync(`${OUT}/proposta.pdf`, await (await page.request.get(`${B}/api/proposals/${pJuliana.id}/pdf`)).body());

  await page.goto(`${B}/app/equipe`); await page.getByText('Convites pendentes').waitFor();
  await shot('11-equipe');
  await page.goto(`${B}/app/assinatura`); await page.getByRole('heading', { name: 'Planos' }).waitFor();
  await shot('12-assinatura');

  // 3) Painel da plataforma
  const adm = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: 'pt-BR' })).newPage();
  await adm.goto(`${B}/admin/login`);
  await adm.getByLabel('E-mail').fill('admin@plataforma.local');
  await adm.getByLabel('Senha').fill(adminPw);
  await adm.screenshot({ path: `${OUT}/13-admin-login.png` });
  await adm.getByRole('button', { name: 'Continuar' }).click();
  await adm.getByLabel(/Código de 6 dígitos/).waitFor();
  await adm.screenshot({ path: `${OUT}/14-admin-mfa.png` });
  await adm.getByLabel(/Código de 6 dígitos/).fill(totpNow());
  await adm.getByRole('button', { name: 'Entrar' }).click();
  await adm.getByText('MRR').waitFor();
  await adm.getByPlaceholder(/Buscar por nome/).fill('Aurora');
  await adm.waitForTimeout(700);
  await adm.screenshot({ path: `${OUT}/15-admin-clientes.png` });
  await adm.getByRole('link', { name: 'Distribuidora Aurora' }).first().click();
  await adm.getByText('Auditoria recente').waitFor();
  await adm.screenshot({ path: `${OUT}/16-admin-cliente.png`, fullPage: true });

  console.log(JSON.stringify({ ok: true, tenant: `aurora-${id}`, errors }));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
