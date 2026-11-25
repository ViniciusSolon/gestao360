import { useState, type FormEvent } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api, brl, dateBR, useApi, useSubmit } from '../lib/api';
import type { PlatformMe } from './AdminLayout';

const STATUS_LABEL: Record<string, string> = { active: 'ativo', past_due: 'inadimplente', suspended: 'suspenso', canceled: 'cancelado', trialing: 'teste (legado)' };

export function AdminTenants() {
  const me = useOutletContext<PlatformMe>();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const metrics = useApi<any>('/platform/metrics');
  const list = useApi<any[]>(`/platform/tenants?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) })}`);
  const m = metrics.data;
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>Clientes</h1>
        {me.role === 'superadmin' && <button onClick={() => setCreating(true)}>+ Novo cliente</button>}
      </div>
      {m && (
        <div className="grid kpis">
          <div className="card kpi"><div className="label">MRR</div><div className="value">{brl(m.mrr_cents)}</div></div>
          <div className="card kpi"><div className="label">Clientes</div><div className="value">{m.tenants}</div><div className="origin">{m.new_30d} novos em 30 dias</div></div>
          <div className="card kpi"><div className="label">Ativos</div><div className="value">{m.active}</div></div>
          <div className="card kpi"><div className="label">Inadimplentes</div><div className="value">{m.past_due}</div></div>
          <div className="card kpi"><div className="label">Suspensos / Cancelados</div><div className="value">{m.suspended} / {m.canceled}</div></div>
          <div className="card kpi"><div className="label">Usuários / Leads</div><div className="value">{m.seats} / {m.leads}</div></div>
        </div>
      )}
      <div className="row">
        <input placeholder="Buscar por nome ou identificador" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">Todos os status</option>
          {['active', 'past_due', 'suspended', 'canceled'].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </div>
      <table>
        <thead><tr><th>Empresa</th><th>Responsável</th><th>Plano</th><th>Status</th><th className="num">Usuários</th><th className="num">Leads</th><th>Último login</th><th>Desde</th></tr></thead>
        <tbody>
          {(list.data ?? []).map((t) => (
            <tr key={t.id}>
              <td><Link to={`/admin/clientes/${t.id}`}>{t.name}</Link><div className="muted">{t.slug}</div></td>
              <td>{t.owner_email ?? '—'}{t.owner_pending && <div><span className="badge past_due">aguardando definir senha</span></div>}</td>
              <td>{t.plan_name}</td>
              <td><span className={`badge ${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span></td>
              <td className="num">{t.seats_used}/{t.max_users}</td>
              <td className="num">{t.leads_count}</td>
              <td>{dateBR(t.last_login_at)}</td>
              <td>{dateBR(t.created_at)}</td>
            </tr>
          ))}
          {list.data && !list.data.length && <tr><td colSpan={8} className="muted">Nenhum cliente encontrado.</td></tr>}
        </tbody>
      </table>
      {creating && <NewClient onClose={() => setCreating(false)} onCreated={() => { list.reload(); metrics.reload(); }} />}
    </div>
  );
}

/** Cadastro de cliente pela plataforma: gera o link para o responsável definir a senha. */
function NewClient({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const plans = useApi<any[]>('/platform/plans');
  const [f, setF] = useState({ companyName: '', slug: '', ownerName: '', ownerEmail: '', planCode: 'starter' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const slugify = (v: string) =>
    v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  const submit = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ accessUrl: string }>('/platform/tenants', { method: 'POST', body: f });
    setLink(r.accessUrl);
    onCreated();
  });
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* sem permissão: o usuário copia à mão */ }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="card modal stack" onClick={(e) => e.stopPropagation()}>
        {!link ? (
          <form className="stack" onSubmit={submit.run}>
            <h2 style={{ margin: 0 }}>Novo cliente</h2>
            <p className="muted" style={{ margin: 0, fontSize: '.85rem' }}>
              A empresa já nasce ativa. O responsável recebe um link para definir a senha (válido por 7 dias, uso único).
            </p>
            <div className="form-grid">
              <label>Empresa<input required minLength={2} value={f.companyName}
                onChange={(e) => setF({ ...f, companyName: e.target.value, slug: slugTouched ? f.slug : slugify(e.target.value) })} /></label>
              <label>Identificador<input required pattern="[a-z0-9][a-z0-9\-]{1,62}" value={f.slug}
                onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: e.target.value.toLowerCase() }); }} /></label>
              <label>Nome do responsável<input required value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} /></label>
              <label>E-mail do responsável<input required type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></label>
              <label>Plano
                <select value={f.planCode} onChange={(e) => setF({ ...f, planCode: e.target.value })}>
                  {(plans.data ?? []).map((p) => <option key={p.code} value={p.code}>{p.name} — {brl(p.price_cents)}/mês</option>)}
                </select>
              </label>
            </div>
            {submit.error && <div className="error">{submit.error}</div>}
            <div className="row"><button disabled={submit.busy}>{submit.busy ? 'Criando…' : 'Criar cliente'}</button><button type="button" className="secondary" onClick={onClose}>Cancelar</button></div>
          </form>
        ) : (
          <>
            <h2 style={{ margin: 0 }}>Cliente criado</h2>
            <p style={{ margin: 0 }}>Envie este link para <strong>{f.ownerName}</strong> ({f.ownerEmail}) definir a senha:</p>
            <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Link de acesso" />
            <p className="muted" style={{ margin: 0, fontSize: '.8rem' }}>
              Também foi enfileirado por e-mail. Enquanto nenhum provedor de e-mail estiver configurado, envie o link por WhatsApp ou e-mail você mesmo.
            </p>
            <div className="row"><button onClick={copy}>{copied ? 'Copiado!' : 'Copiar link'}</button><button className="secondary" onClick={onClose}>Fechar</button></div>
          </>
        )}
      </div>
    </div>
  );
}
