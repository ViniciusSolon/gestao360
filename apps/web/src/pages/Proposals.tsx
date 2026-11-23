import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, brl, dateBR, toCents, useApi, useIdempotencyKey, useSubmit } from '../lib/api';

export function Proposals() {
  const { data } = useApi<any[]>('/proposals');
  return (
    <div>
      <div className="row between"><h1>Propostas</h1><Link to="/app/propostas/nova"><button>Nova proposta</button></Link></div>
      <table>
        <thead><tr><th>Nº</th><th>Cliente</th><th>Status</th><th>Data</th><th className="num">Total</th></tr></thead>
        <tbody>
          {(data ?? []).map((p) => (
            <tr key={p.id}>
              <td><Link to={`/app/propostas/${p.id}`}>#{p.number}</Link></td>
              <td>{p.lead_name}{p.company ? ` — ${p.company}` : ''}</td>
              <td><span className={`badge ${p.status}`}>{p.status}</span></td>
              <td>{dateBR(p.created_at)}</td>
              <td className="num">{brl(p.total_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Item { productId: string; quantity: string; discountPercent: string }

export function ProposalNew() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const leads = useApi<any[]>('/leads?status=open');
  const products = useApi<any[]>('/products?active=true');
  const [leadId, setLeadId] = useState(params.get('leadId') ?? '');
  const [items, setItems] = useState<Item[]>([{ productId: '', quantity: '1', discountPercent: '0' }]);
  const [freight, setFreight] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const idem = useIdempotencyKey();

  // Prévia apenas visual. O total oficial é recalculado no servidor com os preços do cadastro.
  const preview = useMemo(() => {
    const byId = new Map((products.data ?? []).map((p) => [p.id, p]));
    return items.reduce((sum, it) => {
      const p = byId.get(it.productId);
      if (!p) return sum;
      const gross = Number(p.price_cents) * Number(it.quantity.replace(',', '.') || 0);
      const net = gross * (1 - Number(it.discountPercent.replace(',', '.') || 0) / 100);
      return sum + net * (1 + p.tax_rate_bp / 10000);
    }, freight ? toCents(freight) || 0 : 0);
  }, [items, products.data, freight]);

  const submit = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    const p = await api('/proposals', {
      method: 'POST',
      idempotencyKey: idem.key(), // mesma chave em reenvios desta operação
      body: {
        leadId,
        items: items.map((i) => ({ productId: i.productId, quantity: Number(i.quantity.replace(',', '.')), discountPercent: Number(i.discountPercent.replace(',', '.')) })),
        freightCents: freight ? toCents(freight) : 0,
        paymentTerms: paymentTerms || null,
        validUntil: validUntil || null,
      },
    });
    idem.renew();
    nav(`/app/propostas/${p.id}`);
  });

  const setItem = (i: number, k: keyof Item, v: string) => setItems(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  return (
    <form className="stack" onSubmit={submit.run}>
      <h1>Nova proposta</h1>
      <label>Lead / oportunidade
        <select required value={leadId} onChange={(e) => setLeadId(e.target.value)}>
          <option value="">Selecione…</option>
          {(leads.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}{l.company ? ` — ${l.company}` : ''}</option>)}
        </select>
      </label>
      <div className="card stack">
        {items.map((it, i) => (
          <div key={i} className="form-grid">
            <label>Produto
              <select required value={it.productId} onChange={(e) => setItem(i, 'productId', e.target.value)}>
                <option value="">Selecione…</option>
                {(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name} ({brl(p.price_cents)})</option>)}
              </select>
            </label>
            <label>Quantidade<input required inputMode="decimal" value={it.quantity} onChange={(e) => setItem(i, 'quantity', e.target.value)} /></label>
            <label>Desconto (%)<input inputMode="decimal" value={it.discountPercent} onChange={(e) => setItem(i, 'discountPercent', e.target.value)} /></label>
            <div className="row" style={{ alignSelf: 'end' }}>{items.length > 1 && <button type="button" className="secondary" onClick={() => setItems(items.filter((_, j) => j !== i))}>Remover</button>}</div>
          </div>
        ))}
        <div><button type="button" className="secondary" onClick={() => setItems([...items, { productId: '', quantity: '1', discountPercent: '0' }])}>+ Item</button></div>
      </div>
      <div className="form-grid">
        <label>Frete (R$)<input inputMode="decimal" value={freight} onChange={(e) => setFreight(e.target.value)} /></label>
        <label>Condições de pagamento<input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="Ex.: 30/60/90 dias" /></label>
        <label>Validade<input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>
      </div>
      <div className="muted">Prévia: {brl(Math.round(preview))} (o valor final é calculado pelo servidor)</div>
      {submit.error && <div className="error">{submit.error}</div>}
      <div><button disabled={submit.busy}>{submit.busy ? 'Gerando…' : 'Gerar proposta'}</button></div>
    </form>
  );
}

export function ProposalView() {
  const { id } = useParams();
  const { data: p, reload, error } = useApi<any>(`/proposals/${id}`);
  const act = useSubmit(async (action: 'send' | 'accept' | 'reject') => {
    await api(`/proposals/${id}/${action}`, { method: 'POST' });
    reload();
  });
  if (error) return <div className="error">{error.message}</div>;
  if (!p) return <div className="muted">Carregando…</div>;
  return (
    <div className="stack">
      <div className="row between">
        <h1>Proposta #{p.number} <span className={`badge ${p.status}`}>{p.status}</span></h1>
        <div className="row">
          <a href={`/api/proposals/${p.id}/pdf`} target="_blank" rel="noopener"><button className="secondary">PDF</button></a>
          {p.status === 'draft' && <button disabled={act.busy} onClick={() => act.run('send')}>Marcar como enviada</button>}
          {p.status === 'sent' && <><button disabled={act.busy} onClick={() => act.run('accept')}>Aceita</button><button className="danger" disabled={act.busy} onClick={() => act.run('reject')}>Recusada</button></>}
        </div>
      </div>
      {act.error && <div className="error">{act.error}</div>}
      <div><Link to={`/app/leads/${p.lead_id}`}>Ver lead</Link></div>
      <table>
        <thead><tr><th>Item</th><th className="num">Qtd.</th><th className="num">Unitário</th><th className="num">Desc.</th><th className="num">Total</th></tr></thead>
        <tbody>{p.items.map((i: any) => <tr key={i.id}><td>{i.description}</td><td className="num">{Number(i.quantity)}</td><td className="num">{brl(i.unit_price_cents)}</td><td className="num">{i.discount_bp / 100}%</td><td className="num">{brl(i.total_cents)}</td></tr>)}</tbody>
      </table>
      <div className="card" style={{ maxWidth: 360, marginLeft: 'auto' }}>
        <div className="row between"><span>Subtotal</span><span>{brl(p.subtotal_cents)}</span></div>
        <div className="row between"><span>Descontos</span><span>-{brl(p.discount_cents)}</span></div>
        <div className="row between"><span>Tributos (estim.)</span><span>{brl(p.tax_cents)}</span></div>
        <div className="row between"><span>Frete</span><span>{brl(p.freight_cents)}</span></div>
        <div className="row between" style={{ fontWeight: 700 }}><span>Total</span><span>{brl(p.total_cents)}</span></div>
      </div>
    </div>
  );
}
