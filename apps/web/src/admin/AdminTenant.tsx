import { useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { api, brl, dateBR, dateTimeBR, useApi, useSubmit } from '../lib/api';
import type { PlatformMe } from './AdminLayout';

/** Responsável que ainda não definiu a senha: mostra o link pendente e permite gerar outro. */
function PendingOwner({ tenantId, owner, canAct }: { tenantId: string; owner: { name: string; email: string; expires_at: string }; canAct: boolean }) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const gen = useSubmit(async () => {
    const r = await api<{ accessUrl: string }>(`/platform/tenants/${tenantId}/owner-link`, { method: 'POST' });
    setLink(r.accessUrl);
    setCopied(false);
  });
  const expired = new Date(owner.expires_at).getTime() < Date.now();
  return (
    <div className="banner stack" style={{ gap: '.5rem' }}>
      <div>
        <strong>{owner.name}</strong> ({owner.email}) ainda não definiu a senha.{' '}
        {expired ? 'O link venceu.' : `O link vale até ${dateBR(owner.expires_at)}.`}
      </div>
      {canAct && (
        <div className="row">
          <button disabled={gen.busy} onClick={() => gen.run()}>Gerar novo link de acesso</button>
          <span className="muted" style={{ fontSize: '.8rem' }}>O link anterior deixa de valer.</span>
        </div>
      )}
      {link && (
        <div className="row">
          <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Novo link de acesso" style={{ flex: 1, minWidth: 260 }} />
          <button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* copia manual */ } }}>
            {copied ? 'Copiado!' : 'Copiar'}
          </button>
        </div>
      )}
      {gen.error && <div className="error">{gen.error}</div>}
    </div>
  );
}

export function AdminTenant() {
  const { id } = useParams();
  const me = useOutletContext<PlatformMe>();
  const { data, reload, error } = useApi<any>(`/platform/tenants/${id}`);
  const plans = useApi<any[]>('/platform/plans');
  const [reason, setReason] = useState('');
  const action = useSubmit(async (path: string, body: object) => {
    if (reason.trim().length < 3) throw new Error('Informe o motivo (fica registrado na auditoria).');
    await api(`/platform/tenants/${id}/${path}`, { method: 'POST', body: { ...body, reason } });
    setReason('');
    reload();
  });
  if (error) return <div className="error">{error.message}</div>;
  if (!data) return <div className="muted">Carregando…</div>;
  const t = data.tenant;
  const isSuper = me.role === 'superadmin';
  return (
    <div className="stack">
      <h1>{t.name} <span className={`badge ${t.status}`}>{t.status}</span></h1>
      <div className="card form-grid">
        <div><div className="muted">Plano</div>{t.plan_name} ({brl(t.price_cents)})</div>
        <div><div className="muted">Usuários</div>{t.seats_used}/{t.max_users}</div>
        <div><div className="muted">Leads</div>{t.leads_count}/{t.max_leads ?? '∞'}</div>
        <div><div className="muted">Assinatura</div>{data.subscription ? `${data.subscription.status} até ${dateBR(data.subscription.current_period_end)}` : '—'}</div>
        <div><div className="muted">Uso</div>{data.usage.proposals} propostas · {data.usage.activities} atividades · {data.usage.won} ganhos</div>
        {t.suspended_reason && <div><div className="muted">Motivo da suspensão</div>{t.suspended_reason}</div>}
      </div>

      {data.pendingOwner && <PendingOwner tenantId={t.id} owner={data.pendingOwner} canAct={isSuper} />}

      {isSuper ? (
        <div className="card stack">
          <strong>Ações (registradas na auditoria)</strong>
          <label>Motivo<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Obrigatório" /></label>
          <div className="row">
            {t.status !== 'suspended' && <button className="danger" disabled={action.busy} onClick={() => action.run('status', { status: 'suspended' })}>Suspender</button>}
            {t.status !== 'active' && <button disabled={action.busy} onClick={() => action.run('status', { status: 'active' })}>Ativar</button>}
            <select disabled={action.busy} value="" onChange={(e) => e.target.value && action.run('plan', { planCode: e.target.value })} style={{ maxWidth: 220 }}>
              <option value="">Trocar plano…</option>
              {(plans.data ?? []).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </select>
          </div>
          {action.error && <div className="error">{action.error}</div>}
        </div>
      ) : <div className="muted">Seu papel (suporte) é somente leitura.</div>}

      <h2>Usuários</h2>
      <table><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Ativo</th></tr></thead>
        <tbody>{data.users.map((u: any) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.active ? 'sim' : 'não'}</td></tr>)}</tbody></table>
      <h2>Auditoria recente</h2>
      <table><tbody>{data.audit.map((a: any, i: number) => <tr key={i}><td>{dateTimeBR(a.created_at)}</td><td>{a.actor_type}</td><td>{a.action}</td></tr>)}</tbody></table>
    </div>
  );
}
