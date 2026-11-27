import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, call, createTestApp, ORIGIN, resetDb, signup, type Session, type TestCtx } from './helpers.js';
import { isValidCpf } from '../src/lib/cpf.js';

let t: TestCtx;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.app.close(); await t.db.close(); });
beforeEach(async () => { await resetDb(t.db); });

type Profile = { id: string; name: string; role: string };
const profiles = async (s: Session) => (await call(t.app, s, 'GET', '/api/profiles')).json() as Profile[];
const profileOf = async (s: Session, role: string) => (await profiles(s)).find((p) => p.role === role)!;

/** Cria pelo "Novo usuário" e aceita o convite. Devolve a sessão do novo usuário e o id. */
async function createAndAccept(owner: Session, body: Record<string, unknown>) {
  const r = await call(t.app, owner, 'POST', '/api/users', body);
  if (r.statusCode !== 201) throw new Error(`novo usuário: ${r.statusCode} ${r.body}`);
  const token = new URL(r.json().url).searchParams.get('token')!;
  const acc = await t.app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { origin: ORIGIN }, payload: { token, password: 'senha-forte-123' } });
  expect(acc.statusCode, acc.body).toBe(201);
  const users = (await call(t.app, owner, 'GET', '/api/users')).json();
  return users.find((u: any) => u.email === body.email);
}

describe('Perfis (cargo ligado a um nível de acesso)', () => {
  it('quando a empresa é criada, então já tem os perfis Administrador, Gerente e Vendedor', async () => {
    const s = await signup(t.app);
    expect((await profiles(s)).map((p) => [p.name, p.role])).toEqual([['Administrador', 'admin'], ['Gerente', 'manager'], ['Vendedor', 'seller']]);
  });

  it('quando cria "Diretor" com nível administrador e cadastra alguém nele, então a pessoa tem acesso de administrador', async () => {
    const s = await signup(t.app);
    const dir = (await call(t.app, s, 'POST', '/api/profiles', { name: 'Diretor', role: 'admin' })).json();
    const u = await createAndAccept(s, { email: 'diretora@x.com', name: 'Alana Gaspar', profileId: dir.id });
    expect([u.role, u.profile_name]).toEqual(['admin', 'Diretor']);
  });

  it('quando muda o nível do perfil, então muda o acesso de todos os usuários dele', async () => {
    const s = await signup(t.app);
    const sdr = (await call(t.app, s, 'POST', '/api/profiles', { name: 'SDR', role: 'seller' })).json();
    const u = await createAndAccept(s, { email: 'sdr@x.com', name: 'Leila', profileId: sdr.id });
    expect(u.role).toBe('seller');
    const pr = await call(t.app, s, 'PATCH', `/api/profiles/${sdr.id}`, { role: 'manager' });
    expect(pr.statusCode, pr.body).toBe(200);
    expect((await call(t.app, s, 'GET', `/api/users/${u.id}`)).json().role).toBe('manager');
  });

  it('quando um administrador tenta criar/usar perfil acima do dele, ou mexer no próprio perfil, então 403', async () => {
    const owner = await signup(t.app);
    const admin = await addMember(t.app, owner, 'admin');
    const adminProfile = await profileOf(owner, 'admin');
    expect((await call(t.app, admin, 'PATCH', `/api/profiles/${adminProfile.id}`, { role: 'manager' })).statusCode).toBe(403);
    expect((await call(t.app, admin, 'POST', '/api/profiles', { name: 'Dono 2', role: 'owner' })).statusCode).toBe(400);
  });

  it('quando o perfil tem usuários, então não pode ser excluído; sem usuários, pode', async () => {
    const s = await signup(t.app);
    await addMember(t.app, s, 'seller');
    const vend = await profileOf(s, 'seller');
    expect((await call(t.app, s, 'DELETE', `/api/profiles/${vend.id}`)).json().error).toBe('profile_in_use');
    const novo = (await call(t.app, s, 'POST', '/api/profiles', { name: 'Estagiário', role: 'seller' })).json();
    expect((await call(t.app, s, 'DELETE', `/api/profiles/${novo.id}`)).statusCode).toBe(200);
  });

  it('nome de perfil, departamento e squad não se repete (sem diferenciar maiúsculas)', async () => {
    const s = await signup(t.app);
    expect((await call(t.app, s, 'POST', '/api/profiles', { name: 'vendedor', role: 'seller' })).statusCode).toBe(409);
    await call(t.app, s, 'POST', '/api/departments', { name: 'Comercial' });
    expect((await call(t.app, s, 'POST', '/api/departments', { name: 'COMERCIAL' })).statusCode).toBe(409);
  });
});

describe('Novo usuário (cadastro completo)', () => {
  it('quando o administrador preenche o cadastro, então tudo vale para o usuário depois que ele aceita o convite', async () => {
    const s = await signup(t.app);
    const dep = (await call(t.app, s, 'POST', '/api/departments', { name: 'Comercial' })).json();
    const sq1 = (await call(t.app, s, 'POST', '/api/squads', { name: 'Squad Sul' })).json();
    const sq2 = (await call(t.app, s, 'POST', '/api/squads', { name: 'Squad Norte' })).json();
    const vend = await profileOf(s, 'seller');
    const u = await createAndAccept(s, {
      email: 'claudia@x.com', name: 'Claudia Barbara', nickname: 'Clau', profileId: vend.id, mobile: '(21) 99973-0871',
      cpf: '529.982.247-25', birthDate: '1990-05-10', linkedinUrl: 'linkedin.com/in/claudia', meetingUrl: 'https://meet.google.com/abc-defg-hij',
      color: '#22C55E', departmentId: dep.id, squadIds: [sq1.id, sq2.id], admissionDate: '2024-02-01', reportsTo: s.userId, bio: 'Vendedora sênior.',
    });
    expect(u).toMatchObject({
      name: 'Claudia Barbara', nickname: 'Clau', role: 'seller', profile_name: 'Vendedor', mobile: '21999730871', cpf: '52998224725',
      linkedin_url: 'https://linkedin.com/in/claudia', color: '#22c55e', department_name: 'Comercial', reports_to: s.userId, bio: 'Vendedora sênior.', status: 'active',
    });
    expect(u.squads.map((x: any) => x.name)).toEqual(['Squad Norte', 'Squad Sul']);
  });

  it('valida CPF, celular, links e datas', async () => {
    const s = await signup(t.app);
    const vend = await profileOf(s, 'seller');
    const bad = async (extra: Record<string, unknown>) => (await call(t.app, s, 'POST', '/api/users', { email: `x${Math.random()}@x.com`, name: 'X', profileId: vend.id, ...extra })).statusCode;
    expect(await bad({ cpf: '111.111.111-11' })).toBe(400);
    expect(await bad({ cpf: '529.982.247-24' })).toBe(400);
    expect(await bad({ mobile: '9999' })).toBe(400);
    expect(await bad({ meetingUrl: 'javascript:alert(1)' })).toBe(400);
    expect(await bad({ birthDate: '1800-01-01' })).toBe(400);
    expect(await bad({ color: 'red' })).toBe(400);
    expect([isValidCpf('52998224725'), isValidCpf('00000000000')]).toEqual([true, false]);
  });

  it('quando o e-mail já é de um usuário ou tem convite pendente, então 409', async () => {
    const s = await signup(t.app);
    const vend = await profileOf(s, 'seller');
    await createAndAccept(s, { email: 'ja@x.com', name: 'Já', profileId: vend.id });
    expect((await call(t.app, s, 'POST', '/api/users', { email: 'JA@x.com', name: 'Já', profileId: vend.id })).json().error).toBe('user_exists');
    await call(t.app, s, 'POST', '/api/users', { email: 'pend@x.com', name: 'P', profileId: vend.id });
    expect((await call(t.app, s, 'POST', '/api/users', { email: 'pend@x.com', name: 'P', profileId: vend.id })).json().error).toBe('invite_pending');
  });

  it('quando o departamento é excluído antes do aceite, então o usuário entra sem departamento (não quebra o aceite)', async () => {
    const s = await signup(t.app);
    const dep = (await call(t.app, s, 'POST', '/api/departments', { name: 'Temporário' })).json();
    const vend = await profileOf(s, 'seller');
    const r = (await call(t.app, s, 'POST', '/api/users', { email: 'tarde@x.com', name: 'Tarde', profileId: vend.id, departmentId: dep.id })).json();
    await call(t.app, s, 'DELETE', `/api/departments/${dep.id}`);
    const token = new URL(r.url).searchParams.get('token')!;
    const acc = await t.app.inject({ method: 'POST', url: '/api/auth/accept-invite', headers: { origin: ORIGIN }, payload: { token, password: 'senha-forte-123' } });
    expect(acc.statusCode).toBe(201);
  });
});

describe('Status, organograma e privacidade', () => {
  it('Inativo bloqueia o login e derruba as sessões; Terceiro continua acessando', async () => {
    const s = await signup(t.app);
    const seller = await addMember(t.app, s, 'seller');
    expect((await call(t.app, s, 'PATCH', `/api/users/${seller.userId}`, { status: 'third_party' })).json().status).toBe('third_party');
    expect((await call(t.app, seller, 'GET', '/api/leads')).statusCode).toBe(200);
    expect((await call(t.app, s, 'PATCH', `/api/users/${seller.userId}`, { status: 'inactive' })).json().status).toBe('inactive');
    expect((await call(t.app, seller, 'GET', '/api/leads')).statusCode).toBe(401);
  });

  it('"Reporta a" não pode formar ciclo, nem quando dois admins salvam ao mesmo tempo', async () => {
    const s = await signup(t.app);
    const a = await addMember(t.app, s, 'seller');
    const b = await addMember(t.app, s, 'seller');
    expect((await call(t.app, s, 'PATCH', `/api/users/${a.userId}`, { reportsTo: a.userId })).json().error).toBe('reports_to_cycle');
    for (let round = 0; round < 5; round++) {
      await call(t.app, s, 'PATCH', `/api/users/${a.userId}`, { reportsTo: null });
      await call(t.app, s, 'PATCH', `/api/users/${b.userId}`, { reportsTo: null });
      const rs = await Promise.all([
        call(t.app, s, 'PATCH', `/api/users/${a.userId}`, { reportsTo: b.userId }),
        call(t.app, s, 'PATCH', `/api/users/${b.userId}`, { reportsTo: a.userId }),
      ]);
      expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    }
  });

  it('CPF, telefone e nascimento só aparecem para administradores e para a própria pessoa', async () => {
    const s = await signup(t.app);
    const seller = await addMember(t.app, s, 'seller');
    const mgr = await addMember(t.app, s, 'manager');
    await call(t.app, s, 'PATCH', `/api/users/${seller.userId}`, { cpf: '52998224725', birthDate: '1990-01-01', phone: '2133334444', mobile: '21999990000' });
    const asMgr = (await call(t.app, mgr, 'GET', `/api/users/${seller.userId}`)).json();
    expect(asMgr).not.toHaveProperty('cpf');
    expect(asMgr).not.toHaveProperty('birth_date');
    expect(asMgr.mobile).toBe('21999990000');
    expect((await call(t.app, seller, 'GET', `/api/users/${seller.userId}`)).json().cpf).toBe('52998224725');
    expect((await call(t.app, s, 'GET', '/api/users')).json().find((u: any) => u.id === seller.userId).cpf).toBe('52998224725');
    const log = (await t.db.platform.query(`SELECT metadata::text FROM audit_log WHERE action = 'user.updated'`)).rows.map((r) => r.metadata).join();
    expect(log).not.toContain('52998224725');
  });

  it('ninguém muda o próprio acesso nem o do proprietário; gerente não edita usuários', async () => {
    const s = await signup(t.app);
    const admin = await addMember(t.app, s, 'admin');
    const mgr = await addMember(t.app, s, 'manager');
    const vend = await profileOf(s, 'seller');
    expect((await call(t.app, admin, 'PATCH', `/api/users/${admin.userId}`, { profileId: vend.id })).statusCode).toBe(403);
    expect((await call(t.app, admin, 'PATCH', `/api/users/${admin.userId}`, { status: 'inactive' })).statusCode).toBe(403);
    expect((await call(t.app, admin, 'PATCH', `/api/users/${admin.userId}`, { nickname: 'Adm', mobile: '21988887777' })).statusCode).toBe(200);
    expect((await call(t.app, admin, 'PATCH', `/api/users/${s.userId}`, { nickname: 'Chefe' })).statusCode).toBe(403);
    expect((await call(t.app, mgr, 'PATCH', `/api/users/${admin.userId}`, { nickname: 'x' })).statusCode).toBe(403);
    expect((await call(t.app, mgr, 'POST', '/api/users', { email: 'z@x.com', name: 'Z', profileId: vend.id })).statusCode).toBe(403);
  });

  it('foto do usuário: a própria pessoa troca a dela; vendedor não troca a de outro; outra empresa não vê', async () => {
    const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    const s = await signup(t.app);
    const other = await signup(t.app);
    const seller = await addMember(t.app, s, 'seller');
    const put = (who: Session, id: string) => call(t.app, who, 'PUT', `/api/users/${id}/avatar`, PNG, { 'content-type': 'image/png' });
    expect((await put(seller, seller.userId)).statusCode).toBe(200);
    expect((await put(seller, s.userId)).statusCode).toBe(403);
    expect((await call(t.app, s, 'GET', `/api/users/${seller.userId}/avatar`)).statusCode).toBe(200);
    expect((await call(t.app, other, 'GET', `/api/users/${seller.userId}/avatar`)).statusCode).toBe(404);
    expect((await put(other, seller.userId)).statusCode).toBe(404);
  });

  it('a empresa B não vê nem edita usuários, perfis e departamentos da empresa A', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const dep = (await call(t.app, a, 'POST', '/api/departments', { name: 'Secreto' })).json();
    const prof = await profileOf(a, 'seller');
    expect((await call(t.app, b, 'GET', '/api/users')).json().map((u: any) => u.id)).toEqual([b.userId]);
    expect((await call(t.app, b, 'PATCH', `/api/users/${a.userId}`, { nickname: 'x' })).statusCode).toBe(404);
    expect((await call(t.app, b, 'DELETE', `/api/departments/${dep.id}`)).statusCode).toBe(404);
    expect((await call(t.app, b, 'POST', '/api/users', { email: 'y@x.com', name: 'Y', profileId: prof.id })).json().error).toBe('invalid_profile');
    const bUser = await addMember(t.app, b, 'seller');
    expect((await call(t.app, b, 'PATCH', `/api/users/${bUser.userId}`, { departmentId: dep.id })).json().error).toBe('invalid_reference');
  });
});
