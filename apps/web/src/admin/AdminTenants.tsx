import { useState } from 'react';
import { Link } from 'react-router-dom';
import { brl, dateBR, useApi } from '../lib/api';

export function AdminTenants() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const metrics = useApi<any>('/platform/metrics');
  const list = useApi<any[]>(`/platform/tenants?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) })}`);
  const m = metrics.data;
  return (
    <div className="stack">
      <h1>Clientes</h1>
      {m && (
        <div className="grid kpis">
          <div className="card kpi"><div className="label">MRR</div><div className="value">{brl(m.mrr_cents)}</div></div>
          <div className="card kpi"><div className="label">Clientes</div><div className="value">{m.tenants}</div><div className="origin">{m.new_30d} novos em 30 dias</div></div>
          <div className="card kpi"><div className="label">Ativos / Trial</div><div className="value">{m.active} / {m.trialing}</div></div>
          <div className="card kpi"><div className="label">Inadimplentes</div><div className="value">{m.past_due}</div></div>
          <div className="card kpi"><div className="label">Suspensos / Cancelados</div><div className="value">{m.suspended} / {m.canceled}</div></div>
          <div className="card kpi"><div className="label">Usuários / Leads</div><div className="value">{m.seats} / {m.leads}</div></div>
        </div>
      )}
      <div className="row">
        <input placeholder="Buscar por nome ou identificador" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">Todos os status</option>
          {['trialing', 'active', 'past_due', 'suspended', 'canceled'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <table>
        <thead><tr><th>Empresa</th><th>Owner</th><th>Plano</th><th>Status</th><th className="num">Usuários</th><th className="num">Leads</th><th>Último login</th><th>Desde</th></tr></thead>
        <tbody>
          {(list.data ?? []).map((t) => (
            <tr key={t.id}>
              <td><Link to={`/admin/clientes/${t.id}`}>{t.name}</Link><div className="muted">{t.slug}</div></td>
              <td>{t.owner_email}</td>
              <td>{t.plan_name}</td>
              <td><span className={`badge ${t.status}`}>{t.status}</span>{t.status === 'trialing' && <div className="muted">até {dateBR(t.trial_ends_at)}</div>}</td>
              <td className="num">{t.seats_used}/{t.max_users}</td>
              <td className="num">{t.leads_count}</td>
              <td>{dateBR(t.last_login_at)}</td>
              <td>{dateBR(t.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
