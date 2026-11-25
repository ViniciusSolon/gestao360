import { useSearchParams } from 'react-router-dom';
import { api, brl, dateBR, useApi, useIdempotencyKey, useSubmit } from '../lib/api';
import { useSession } from '../lib/session';

const STATUS: Record<string, string> = { trialing: 'Ativa', active: 'Ativa', past_due: 'Pagamento pendente', suspended: 'Suspensa', canceled: 'Cancelada' };

export function Billing() {
  const { me } = useSession();
  const { data } = useApi<any>('/billing');
  const idem = useIdempotencyKey();
  const checkout = useSubmit(async (planCode: string) => {
    // A chave identifica ESTA tentativa no cliente; o servidor ainda reaproveita a chave do gateway por operação.
    const r = await api('/billing/checkout', { method: 'POST', body: { planCode }, idempotencyKey: `${idem.key()}:${planCode}` });
    location.assign(r.checkoutUrl);
  });
  if (!data) return <div className="muted">Carregando…</div>;
  const t = data.tenant;
  return (
    <div className="stack">
      <h1>Assinatura</h1>
      <div className="card form-grid">
        <div><div className="muted">Plano</div>{t.plan_name}</div>
        <div><div className="muted">Situação</div><span className={`badge ${t.status}`}>{STATUS[t.status] ?? t.status}</span></div>
        <div><div className="muted">Usuários</div>{t.seats_used} / {t.max_users}</div>
        <div><div className="muted">Leads</div>{t.leads_count} / {t.max_leads ?? '∞'}</div>
      </div>
      <h2>Planos</h2>
      <div className="grid kpis">
        {data.plans.map((p: any) => (
          <div key={p.code} className="card stack">
            <strong>{p.name}</strong>
            <div className="value" style={{ fontSize: '1.3rem' }}>{brl(p.price_cents)}<span className="muted">/mês</span></div>
            <div className="muted">{p.max_users} usuários · {p.max_leads ? `${p.max_leads} leads` : 'leads ilimitados'}</div>
            {me.user.role === 'owner' ? (
              <button disabled={checkout.busy || (t.status === 'active' && t.plan_code === p.code)} onClick={() => checkout.run(p.code)}>
                {t.status === 'active' && t.plan_code === p.code ? 'Plano atual' : 'Assinar'}
              </button>
            ) : <span className="muted">Apenas o proprietário pode assinar</span>}
          </div>
        ))}
      </div>
      {checkout.error && <div className="error">{checkout.error}</div>}
    </div>
  );
}

/** Página do gateway FAKE (somente desenvolvimento): simula o pagamento. */
export function FakeCheckout() {
  const [params] = useSearchParams();
  const pay = useSubmit(async () => {
    await api(`/webhooks/dev/fake-checkout/${params.get('session')}/complete`, { method: 'POST', body: {} });
    setTimeout(() => location.assign('/app/assinatura?status=ok'), 1500);
  });
  return (
    <div className="card auth stack">
      <h1>Checkout de teste</h1>
      <p className="muted">Gateway simulado. Em produção o cliente é levado ao checkout real do provedor.</p>
      <button disabled={pay.busy} onClick={() => pay.run()}>Simular pagamento aprovado</button>
      {pay.error && <div className="error">{pay.error}</div>}
    </div>
  );
}
