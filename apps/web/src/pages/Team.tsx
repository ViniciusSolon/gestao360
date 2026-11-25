import { useState, type FormEvent } from 'react';
import { api, can, dateBR, ROLE_LABEL, useApi, useSubmit, type Role } from '../lib/api';
import { useSession } from '../lib/session';

export function Team() {
  const { me } = useSession();
  const users = useApi<any[]>('/users');
  const invites = useApi<any[]>('/invites');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('seller');
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const invite = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    const r = await api('/invites', { method: 'POST', body: { email, role, name: name || undefined } });
    setLastUrl(r.url);
    setEmail('');
    setName('');
    invites.reload();
  });
  const update = useSubmit(async (id: string, body: object) => {
    await api(`/users/${id}`, { method: 'PATCH', body });
    users.reload();
  });
  const roles: Role[] = (['seller', 'manager', 'admin'] as Role[]).filter((r) => can(me.user.role, r));
  return (
    <div className="stack">
      <h1>Equipe</h1>
      <form className="card form-grid" onSubmit={invite.run}>
        <label>Nome (opcional)<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>E-mail<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Papel<select value={role} onChange={(e) => setRole(e.target.value as Role)}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
        <div className="row" style={{ alignSelf: 'end' }}><button disabled={invite.busy}>Convidar</button></div>
        {invite.error && <div className="error">{invite.error}</div>}
        {lastUrl && <div className="muted" style={{ gridColumn: '1/-1', wordBreak: 'break-all' }}>Link do convite (também enviado por e-mail): {lastUrl}</div>}
      </form>
      {update.error && <div className="error">{update.error}</div>}
      <table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Status</th><th /></tr></thead>
        <tbody>
          {(users.data ?? []).map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td><td>{u.email}</td>
              <td>{u.role === 'owner' || u.id === me.user.id ? ROLE_LABEL[u.role as Role] : (
                <select value={u.role} disabled={update.busy} onChange={(e) => update.run(u.id, { role: e.target.value })} style={{ width: 160 }}>
                  {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              )}</td>
              <td>{u.active ? 'Ativo' : 'Inativo'}</td>
              <td>{u.role !== 'owner' && u.id !== me.user.id && <button className="secondary" disabled={update.busy} onClick={() => update.run(u.id, { active: !u.active })}>{u.active ? 'Desativar' : 'Reativar'}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Convites pendentes</h2>
      <table><tbody>
        {(invites.data ?? []).map((i) => <tr key={i.id}><td>{i.email}</td><td>{ROLE_LABEL[i.role as Role]}</td><td>expira {dateBR(i.expires_at)}</td>
          <td><button className="secondary" onClick={async () => { await api(`/invites/${i.id}`, { method: 'DELETE' }); invites.reload(); }}>Revogar</button></td></tr>)}
        {invites.data && !invites.data.length && <tr><td className="muted">Nenhum convite pendente</td></tr>}
      </tbody></table>
    </div>
  );
}
