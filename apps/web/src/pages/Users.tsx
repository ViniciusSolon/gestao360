import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, can, dateBR, ROLE_LABEL, useApi, useSubmit, type Role } from '../lib/api';
import { useSession } from '../lib/session';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
type Status = 'active' | 'third_party' | 'inactive';
interface Named { id: string; name: string }
interface Profile extends Named { role: Role; users?: number }
export interface User {
  id: string; name: string; nickname: string | null; email: string; role: Role; status: Status; color: string | null;
  mobile: string | null; phone?: string | null; cpf?: string | null; birth_date?: string | null; linkedin_url: string | null; meeting_url: string | null;
  department_id: string | null; department_name: string | null; profile_id: string | null; profile_name: string | null;
  admission_date: string | null; reports_to: string | null; reports_to_name: string | null; bio: string | null;
  avatar_updated_at: string | null; squads: Named[];
}
interface Invite { id: string; email: string; name: string | null; role: Role; profile_name: string | null; expires_at: string; created_at: string }

const STATUS_LABEL: Record<Status, string> = { active: 'Ativo', third_party: 'Terceiro', inactive: 'Inativo' };
const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#64748b'];

const onlyDigits = (v: string) => v.replace(/\D/g, '');
export function maskPhone(v: string) {
  const d = onlyDigits(v).slice(0, 11);
  if (d.length <= 2) return d ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
const maskCpf = (v: string) => {
  const d = onlyDigits(v).slice(0, 11);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)].filter(Boolean).join('.') + (d.length > 9 ? `-${d.slice(9)}` : '');
};
const fmtPhone = (v: string | null | undefined) => (v ? maskPhone(v.length > 11 && v.startsWith('55') ? v.slice(2) : v) : '');
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/** Foto do usuário, ou iniciais na cor dele. */
export function Avatar({ user, size = 32 }: { user: Pick<User, 'id' | 'name' | 'color' | 'avatar_updated_at'>; size?: number }) {
  const style = { width: size, height: size, fontSize: size * 0.38, background: user.color ?? 'var(--primary)' };
  if (user.avatar_updated_at) {
    return <img className="avatar" style={style} alt="" src={`/api/users/${user.id}/avatar?v=${encodeURIComponent(user.avatar_updated_at)}`} />;
  }
  return <span className="avatar" style={style} aria-hidden>{initials(user.name)}</span>;
}

// ---------------------------------------------------------------------------
// Lista de usuários
// ---------------------------------------------------------------------------
export function Users() {
  const { me } = useSession();
  const users = useApi<User[]>('/users');
  const invites = useApi<Invite[]>('/invites');
  const departments = useApi<Named[]>('/departments');
  const [tab, setTab] = useState<'users' | 'invites'>('users');
  const [q, setQ] = useState('');
  const [dep, setDep] = useState('');
  const [status, setStatus] = useState<'' | Status>('');
  const [view, setView] = useState<'list' | 'grid'>(() => {
    try { return localStorage.getItem('users-view') === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
  });
  const [profilesOpen, setProfilesOpen] = useState(false);
  const nav = useNavigate();

  const setViewSaved = (v: 'list' | 'grid') => {
    setView(v);
    try { localStorage.setItem('users-view', v); } catch { /* sem armazenamento: tudo bem */ }
  };
  const update = useSubmit(async (id: string, body: object) => {
    await api(`/users/${id}`, { method: 'PATCH', body });
    users.reload();
  });
  const revoke = useSubmit(async (id: string) => {
    await api(`/invites/${id}`, { method: 'DELETE' });
    invites.reload();
  });

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = onlyDigits(q);
    return (users.data ?? []).filter((u) =>
      (!dep || u.department_id === dep) &&
      (!status || u.status === status) &&
      (!needle || `${u.name} ${u.nickname ?? ''} ${u.email} ${u.profile_name ?? ''}`.toLowerCase().includes(needle) || (digits.length >= 4 && !!u.mobile?.includes(digits))),
    );
  }, [users.data, q, dep, status]);

  const menu = (u: User) => {
    const editable = u.role !== 'owner' && u.id !== me.user.id && can(me.user.role, u.role);
    return (
      <RowMenu label={`Ações de ${u.name}`}>
        <button type="button" onClick={() => nav(`/app/organizacao/usuarios/${u.id}`)}>Editar</button>
        {editable && u.status !== 'inactive' && <button type="button" onClick={() => confirm(`Inativar ${u.name}? A pessoa perde o acesso na hora.`) && update.run(u.id, { status: 'inactive' })}>Inativar</button>}
        {editable && u.status === 'inactive' && <button type="button" onClick={() => update.run(u.id, { status: 'active' })}>Reativar</button>}
        <a href={`mailto:${u.email}`}>Enviar e-mail</a>
      </RowMenu>
    );
  };

  return (
    <div className="users">
      <div className="users-top">
        <div className="seg" role="tablist" aria-label="Usuários e convites">
          <button role="tab" aria-selected={tab === 'users'} className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>
            Usuários <span className="count">{users.data?.length ?? '…'}</span>
          </button>
          <button role="tab" aria-selected={tab === 'invites'} className={tab === 'invites' ? 'on' : ''} onClick={() => setTab('invites')}>
            Convites {!!invites.data?.length && <span className="count">{invites.data.length}</span>}
          </button>
        </div>
        <button type="button" className="secondary" onClick={() => setProfilesOpen(true)}>Perfis de acesso</button>
      </div>

      {tab === 'users' ? (
        <>
          <div className="users-filters">
            <input type="search" placeholder="Buscar usuários…" aria-label="Buscar usuários" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="Departamento" value={dep} onChange={(e) => setDep(e.target.value)}>
              <option value="">Todos os departamentos</option>
              {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as '' | Status)}>
              <option value="">Todos os status</option>
              {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <div className="seg icons" role="group" aria-label="Visualização">
              <button type="button" aria-pressed={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setViewSaved('list')} title="Lista" aria-label="Lista">☰</button>
              <button type="button" aria-pressed={view === 'grid'} className={view === 'grid' ? 'on' : ''} onClick={() => setViewSaved('grid')} title="Cartões" aria-label="Cartões">▦</button>
            </div>
            <Link className="btn btn-new" to="/app/organizacao/usuarios/novo">+ Novo</Link>
          </div>
          {(update.error || users.error) && <p className="error">{update.error ?? users.error?.message}</p>}

          {view === 'list' ? (
            <div className="users-table">
              <table>
                <thead><tr><th /><th>Nome</th><th>Perfil</th><th>Squads</th><th>Celular</th><th>E-mail</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {list.map((u) => (
                    <tr key={u.id}>
                      <td className="av"><Avatar user={u} /></td>
                      <td><Link to={`/app/organizacao/usuarios/${u.id}`} className="uname">{u.name}</Link>{u.department_name && <small className="muted">{u.department_name}</small>}</td>
                      <td>{u.profile_name ?? (u.role === 'owner' ? ROLE_LABEL.owner : '—')}</td>
                      <td>{u.squads.map((s) => <span key={s.id} className="chip">{s.name}</span>)}</td>
                      <td>{u.mobile ? fmtPhone(u.mobile) : <span className="warn-text">⚠ Sem celular</span>}</td>
                      <td><a href={`mailto:${u.email}`} title={u.email} aria-label={`E-mail de ${u.name}: ${u.email}`} className="mail-icon">✉</a></td>
                      <td><span className={`st st-${u.status}`}>{STATUS_LABEL[u.status]}</span></td>
                      <td>{menu(u)}</td>
                    </tr>
                  ))}
                  {users.data && !list.length && <tr><td colSpan={8} className="muted">Nenhum usuário com estes filtros.</td></tr>}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="users-grid">
              {list.map((u) => (
                <div key={u.id} className="card ucard">
                  <div className="ucard-menu">{menu(u)}</div>
                  <Avatar user={u} size={56} />
                  <Link to={`/app/organizacao/usuarios/${u.id}`} className="uname">{u.name}</Link>
                  <div className="muted">{u.profile_name ?? ROLE_LABEL[u.role]}{u.department_name ? ` · ${u.department_name}` : ''}</div>
                  <div>{u.mobile ? fmtPhone(u.mobile) : <span className="warn-text">⚠ Sem celular</span>}</div>
                  <span className={`st st-${u.status}`}>{STATUS_LABEL[u.status]}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="users-table">
          {revoke.error && <p className="error">{revoke.error}</p>}
          <table>
            <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Convidado em</th><th>Expira</th><th /></tr></thead>
            <tbody>
              {invites.data?.map((i) => (
                <tr key={i.id}>
                  <td>{i.name ?? '—'}</td><td>{i.email}</td><td>{i.profile_name ?? ROLE_LABEL[i.role]}</td>
                  <td>{dateBR(i.created_at)}</td><td>{dateBR(i.expires_at)}</td>
                  <td><button className="secondary sm" disabled={revoke.busy} onClick={() => confirm(`Cancelar o convite de ${i.email}?`) && revoke.run(i.id)}>Cancelar convite</button></td>
                </tr>
              ))}
              {invites.data && !invites.data.length && <tr><td colSpan={6} className="muted">Nenhum convite pendente.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {profilesOpen && <ProfilesDialog onClose={() => { setProfilesOpen(false); users.reload(); }} />}
    </div>
  );
}

/** Menu "⋯" da linha (fecha ao clicar fora ou apertar Esc). */
function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="rowmenu" ref={ref}>
      <button type="button" className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
      {open && <div className="rowmenu-list" role="menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Perfis de acesso (cargo → nível)
// ---------------------------------------------------------------------------
function ProfilesDialog({ onClose }: { onClose: () => void }) {
  const { me } = useSession();
  const { data, reload } = useApi<Profile[]>('/profiles');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('seller');
  const levels = (['seller', 'manager', 'admin'] as Role[]).filter((r) => can(me.user.role, r));
  const act = useSubmit(async (fn: () => Promise<unknown>) => { await fn(); await reload(); });
  return (
    <div className="modal-bg" role="dialog" aria-modal="true" aria-labelledby="pf-title" onClick={onClose}>
      <div className="card modal stack" onClick={(e) => e.stopPropagation()}>
        <h2 id="pf-title" style={{ margin: 0 }}>Perfis de acesso</h2>
        <p className="muted" style={{ margin: 0, fontSize: '.88rem' }}>
          Cada perfil (Diretor, Vendedor…) dá um nível de acesso. Mudar o nível de um perfil muda o acesso de todos os usuários dele.
        </p>
        <table>
          <thead><tr><th>Perfil</th><th>Nível de acesso</th><th className="num">Usuários</th><th /></tr></thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>
                  <select aria-label={`Nível de ${p.name}`} value={p.role} disabled={act.busy || !can(me.user.role, p.role)}
                    onChange={(e) => {
                      const r = e.target.value as Role;
                      if (!p.users || confirm(`Mudar "${p.name}" para ${ROLE_LABEL[r]}? Isso muda o acesso de ${p.users} usuário(s).`))
                        act.run(() => api(`/profiles/${p.id}`, { method: 'PATCH', body: { role: r } }));
                    }}>
                    {(can(me.user.role, p.role) ? levels : [p.role]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                </td>
                <td className="num">{p.users ?? 0}</td>
                <td>
                  <button className="icon-btn" aria-label={`Excluir perfil ${p.name}`} title={p.users ? 'Troque o perfil dos usuários antes' : 'Excluir'}
                    disabled={act.busy || !!p.users} onClick={() => confirm(`Excluir o perfil "${p.name}"?`) && act.run(() => api(`/profiles/${p.id}`, { method: 'DELETE' }))}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); act.run(async () => { await api('/profiles', { method: 'POST', body: { name, role } }); setName(''); }); }}>
          <input aria-label="Nome do novo perfil" placeholder="Novo perfil (ex.: Diretor)" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} style={{ flex: 2, minWidth: 160 }} />
          <select aria-label="Nível do novo perfil" value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ flex: 1, minWidth: 130 }}>
            {levels.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <button disabled={act.busy}>Adicionar</button>
        </form>
        {act.error && <p className="error">{act.error}</p>}
        <div><button className="secondary" onClick={onClose}>Fechar</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Novo usuário / Editar usuário
// ---------------------------------------------------------------------------
const emptyForm = {
  name: '', nickname: '', email: '', mobile: '', phone: '', cpf: '', birthDate: '', linkedinUrl: '', meetingUrl: '', color: COLORS[0],
  status: 'active' as Status, departmentId: '', profileId: '', squadIds: [] as string[], admissionDate: '', reportsTo: '', bio: '',
};

export function UserForm() {
  const { id } = useParams();
  const { me } = useSession();
  const nav = useNavigate();
  const existing = useApi<User>(id ? `/users/${id}` : null);
  const users = useApi<User[]>('/users');
  const profiles = useApi<Profile[]>('/profiles');
  const departments = useApi<Named[]>('/departments');
  const squads = useApi<Named[]>('/squads');
  const [f, setF] = useState(emptyForm);
  const [loaded, setLoaded] = useState(!id);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const set = <K extends keyof typeof emptyForm>(k: K, v: (typeof emptyForm)[K]) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    const u = existing.data;
    if (!u || loaded) return;
    setF({
      name: u.name, nickname: u.nickname ?? '', email: u.email, mobile: fmtPhone(u.mobile), phone: fmtPhone(u.phone), cpf: u.cpf ? maskCpf(u.cpf) : '',
      birthDate: u.birth_date?.slice(0, 10) ?? '', linkedinUrl: u.linkedin_url ?? '', meetingUrl: u.meeting_url ?? '', color: u.color ?? COLORS[0],
      status: u.status, departmentId: u.department_id ?? '', profileId: u.profile_id ?? '', squadIds: u.squads.map((s) => s.id),
      admissionDate: u.admission_date?.slice(0, 10) ?? '', reportsTo: u.reports_to ?? '', bio: u.bio ?? '',
    });
    setLoaded(true);
  }, [existing.data, loaded]);

  const target = existing.data;
  const isSelf = !!id && id === me.user.id;
  const isOwner = target?.role === 'owner';
  const accessLocked = isSelf || isOwner; // ninguém muda o próprio acesso; o do proprietário não muda
  const levels = (profiles.data ?? []).filter((p) => can(me.user.role, p.role));

  const save = useSubmit(async () => {
    const common = {
      name: f.name, nickname: f.nickname || null, mobile: f.mobile || null, phone: f.phone || null, cpf: f.cpf || null,
      birthDate: f.birthDate || null, linkedinUrl: f.linkedinUrl || null, meetingUrl: f.meetingUrl || null, color: f.color,
      departmentId: f.departmentId || null, squadIds: f.squadIds, admissionDate: f.admissionDate || null, reportsTo: f.reportsTo || null, bio: f.bio || null,
    };
    if (!id) {
      const r = await api<{ url: string }>('/users', {
        method: 'POST', body: { ...common, email: f.email, profileId: f.profileId, thirdParty: f.status === 'third_party' },
      });
      setInviteUrl(r.url);
      return;
    }
    const body: Record<string, unknown> = { ...common };
    if (!accessLocked) { body.status = f.status; if (f.profileId) body.profileId = f.profileId; }
    else if (isOwner && f.profileId !== (target?.profile_id ?? '')) body.profileId = f.profileId || null;
    await api(`/users/${id}`, { method: 'PATCH', body });
    nav('/app/organizacao/usuarios');
  });

  const addNamed = async (path: 'departments' | 'squads', label: string) => {
    const name = prompt(`Nome do novo ${label}:`)?.trim();
    if (!name) return null;
    try {
      const r = await api<Named>(`/${path}`, { method: 'POST', body: { name } });
      await (path === 'departments' ? departments : squads).reload();
      return r.id;
    } catch (e) {
      save.setError((e as ApiError).message);
      return null;
    }
  };

  if (id && existing.error) return <p className="error">{existing.error.message}</p>;
  if (!loaded) return <p className="muted">Carregando…</p>;

  if (inviteUrl) {
    return (
      <div className="card stack uf-done">
        <h1>Convite enviado</h1>
        <p><b>{f.name}</b> recebeu um e-mail em <b>{f.email}</b> para definir a senha. O cadastro que você preencheu já vale quando a pessoa entrar.</p>
        <label>Link do convite (se o e-mail não chegar, envie este link; vale 7 dias)
          <input readOnly value={inviteUrl} onFocus={(e) => e.target.select()} />
        </label>
        <div className="row">
          <button type="button" onClick={() => navigator.clipboard?.writeText(inviteUrl)}>Copiar link</button>
          <Link to="/app/organizacao/usuarios" className="btn secondary-link">Voltar para usuários</Link>
        </div>
      </div>
    );
  }

  const preview = { id: id ?? 'novo', name: f.name || '?', color: f.color, avatar_updated_at: target?.avatar_updated_at ?? null };
  return (
    <form className="uf" onSubmit={(e: FormEvent) => { e.preventDefault(); save.run(); }}>
      <div className="uf-head">
        <Link to="/app/organizacao/usuarios" className="back">← Voltar</Link>
        <div className="uf-title">
          <span className="uf-icon" aria-hidden>👤</span>
          <div><h1>{id ? 'Editar usuário' : 'Novo usuário'}</h1><small className="muted">Preencha os dados do usuário</small></div>
        </div>
      </div>

      <section className="card">
        <h2 className="uf-sec">Dados pessoais</h2>
        <div className="uf-personal">
          <div className="uf-grid">
            <label>Nome completo *<input required maxLength={120} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Nome completo do usuário" /></label>
            <label>Apelido<input maxLength={60} value={f.nickname} onChange={(e) => set('nickname', e.target.value)} placeholder="Como prefere ser chamado" /></label>
            <label>E-mail {!id && '*'}<input type="email" required={!id} readOnly={!!id} value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="email@empresa.com" />
              {id && <small className="muted">O e-mail é o login e não muda por aqui.</small>}
            </label>
            <label>Celular<input inputMode="tel" value={f.mobile} onChange={(e) => set('mobile', maskPhone(e.target.value))} placeholder="(00) 00000-0000" /></label>
            <label>Telefone<input inputMode="tel" value={f.phone} onChange={(e) => set('phone', maskPhone(e.target.value))} placeholder="(00) 0000-0000" /></label>
            <label>CPF<input inputMode="numeric" value={f.cpf} onChange={(e) => set('cpf', maskCpf(e.target.value))} placeholder="000.000.000-00" autoComplete="off" /></label>
            <label>Data de nascimento<input type="date" value={f.birthDate} onChange={(e) => set('birthDate', e.target.value)} /></label>
            <label>LinkedIn<input value={f.linkedinUrl} onChange={(e) => set('linkedinUrl', e.target.value)} placeholder="linkedin.com/in/usuario" /></label>
            <label>Link de reunião<input value={f.meetingUrl} onChange={(e) => set('meetingUrl', e.target.value)} placeholder="https://meet.google.com/…" /></label>
            <fieldset className="uf-colors">
              <legend>Cor padrão</legend>
              <div className="row">
                {COLORS.map((c) => (
                  <label key={c} className="swatch" style={{ background: c }} title={c}>
                    <input type="radio" name="color" value={c} checked={f.color === c} onChange={() => set('color', c)} aria-label={`Cor ${c}`} />
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <AvatarField userId={id} preview={preview} canEdit={!!id && (isSelf || (!isOwner && can(me.user.role, target?.role ?? 'seller')))} onChanged={() => existing.reload()} />
        </div>
      </section>

      <section className="card">
        <h2 className="uf-sec">Dados profissionais</h2>
        <div className="uf-grid">
          <fieldset className="uf-full">
            <legend>Status</legend>
            <div className="row">
              {(Object.keys(STATUS_LABEL) as Status[]).filter((s) => id || s !== 'inactive').map((s) => (
                <label key={s} className="chk"><input type="radio" name="status" checked={f.status === s} disabled={accessLocked} onChange={() => set('status', s)} />
                  <span className={`dot dot-${s}`} aria-hidden /> {STATUS_LABEL[s]}
                </label>
              ))}
            </div>
            {accessLocked && <small className="muted">{isOwner ? 'O acesso do proprietário não muda.' : 'Você não pode alterar o próprio acesso.'}</small>}
          </fieldset>
          <label>Departamento
            <div className="row nowrap">
              <select value={f.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
                <option value="">Selecione…</option>
                {departments.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <button type="button" className="secondary sm" onClick={async () => { const nid = await addNamed('departments', 'departamento'); if (nid) set('departmentId', nid); }}>+ Novo</button>
            </div>
          </label>
          <label>Perfil {!id && '*'}
            <select required={!id} value={f.profileId} disabled={accessLocked && !isOwner} onChange={(e) => set('profileId', e.target.value)}>
              <option value="">{isOwner ? 'Proprietário (sem cargo)' : 'Selecione…'}</option>
              {(isOwner ? profiles.data ?? [] : levels).map((p) => <option key={p.id} value={p.id}>{p.name}{isOwner ? '' : ` · acesso ${ROLE_LABEL[p.role]}`}</option>)}
            </select>
            {isOwner && <small className="muted">Para o proprietário, o perfil é só o cargo; o acesso continua total.</small>}
          </label>
          <div className="uf-full">
            <span className="lbl">Squads</span>
            <div className="chips-edit">
              {f.squadIds.map((sid) => {
                const s = squads.data?.find((x) => x.id === sid);
                return s ? <span key={sid} className="chip">{s.name}<button type="button" aria-label={`Remover ${s.name}`} onClick={() => set('squadIds', f.squadIds.filter((x) => x !== sid))}>×</button></span> : null;
              })}
              <select aria-label="Adicionar squad" value="" onChange={async (e) => {
                const v = e.target.value;
                if (v === '__new') { const nid = await addNamed('squads', 'squad'); if (nid) set('squadIds', [...f.squadIds, nid]); }
                else if (v) set('squadIds', [...f.squadIds, v]);
              }}>
                <option value="">Adicionar squad…</option>
                {squads.data?.filter((s) => !f.squadIds.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                <option value="__new">+ Criar squad…</option>
              </select>
            </div>
          </div>
          <label>Data de admissão<input type="date" value={f.admissionDate} onChange={(e) => set('admissionDate', e.target.value)} /></label>
          <label>Reporta a
            <select value={f.reportsTo} onChange={(e) => set('reportsTo', e.target.value)}>
              <option value="">Ninguém</option>
              {users.data?.filter((u) => u.id !== id && u.status !== 'inactive').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="uf-full">Biografia<textarea rows={3} maxLength={1000} value={f.bio} onChange={(e) => set('bio', e.target.value)} placeholder="Breve descrição sobre o usuário" /></label>
        </div>
      </section>

      {save.error && <p className="error" role="alert">{save.error}</p>}
      <div className="row uf-actions">
        <Link to="/app/organizacao/usuarios" className="btn secondary-link">Cancelar</Link>
        <button disabled={save.busy}>{save.busy ? 'Salvando…' : id ? 'Salvar' : 'Criar e enviar convite'}</button>
      </div>
      {!id && <p className="muted uf-note">A pessoa recebe um e-mail para definir a senha. A foto pode ser enviada depois, por ela ou por você.</p>}
    </form>
  );
}

function AvatarField({ userId, preview, canEdit, onChanged }: {
  userId?: string; preview: Pick<User, 'id' | 'name' | 'color' | 'avatar_updated_at'>; canEdit: boolean; onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const up = useSubmit(async (file: File) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Use JPEG, PNG ou WebP.');
    if (file.size > 2 * 1024 * 1024) throw new Error('A foto precisa ter até 2 MB.');
    const res = await fetch(`/api/users/${userId}/avatar`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': file.type }, body: file });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? `Erro ${res.status}`);
    onChanged();
  });
  return (
    <div className="uf-avatar">
      {canEdit ? (
        <button type="button" className="uf-avatar-btn" onClick={() => input.current?.click()} disabled={up.busy} aria-label="Trocar foto" title="Clique para trocar a foto">
          <Avatar user={preview} size={96} />
          <span className="uf-avatar-hint">{up.busy ? 'Enviando…' : 'Trocar foto'}</span>
        </button>
      ) : <Avatar user={preview} size={96} />}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) up.run(file); }} />
      {up.error && <small className="error">{up.error}</small>}
    </div>
  );
}
