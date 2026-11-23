import { useState, type FormEvent } from 'react';
import { api, brl, can, toCents, useApi, useSubmit } from '../lib/api';
import { useSession } from '../lib/session';

export function Products() {
  const { me } = useSession();
  const { data, reload } = useApi<any[]>('/products');
  const empty = { sku: '', name: '', price: '', ncm: '', taxPercent: '0', photoUrl: '' };
  const [f, setF] = useState(empty);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    await api('/products', {
      method: 'POST',
      body: { sku: f.sku, name: f.name, priceCents: toCents(f.price), ncm: f.ncm || null, taxRateBp: Math.round(Number(f.taxPercent.replace(',', '.')) * 100), photoUrl: f.photoUrl || null },
    });
    setF(empty);
    reload();
  });
  const toggle = async (p: any) => { await api(`/products/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); reload(); };
  const editable = can(me.user.role, 'manager');
  return (
    <div>
      <h1>Catálogo de produtos</h1>
      {editable && (
        <form className="card form-grid" onSubmit={submit.run} style={{ marginBottom: '1rem' }}>
          <label>SKU<input required value={f.sku} onChange={set('sku')} /></label>
          <label>Nome<input required value={f.name} onChange={set('name')} /></label>
          <label>Preço (R$)<input required inputMode="decimal" value={f.price} onChange={set('price')} /></label>
          <label>NCM<input pattern="[0-9]{8}" value={f.ncm} onChange={set('ncm')} placeholder="8 dígitos" /></label>
          <label>Tributos estimados (%)<input inputMode="decimal" value={f.taxPercent} onChange={set('taxPercent')} /></label>
          <label>Foto (URL https)<input type="url" pattern="https://.*" value={f.photoUrl} onChange={set('photoUrl')} /></label>
          <div className="row" style={{ alignSelf: 'end' }}><button disabled={submit.busy}>Adicionar</button></div>
          {submit.error && <div className="error">{submit.error}</div>}
        </form>
      )}
      <table>
        <thead><tr><th /><th>SKU</th><th>Produto</th><th>NCM</th><th className="num">Preço</th><th className="num">Tributos</th><th>Status</th></tr></thead>
        <tbody>
          {(data ?? []).map((p) => (
            <tr key={p.id}>
              <td>{p.photo_url && <img src={p.photo_url} alt="" width={36} height={36} style={{ objectFit: 'cover', borderRadius: 6 }} referrerPolicy="no-referrer" />}</td>
              <td>{p.sku}</td><td>{p.name}</td><td>{p.ncm ?? '—'}</td>
              <td className="num">{brl(p.price_cents)}</td><td className="num">{p.tax_rate_bp / 100}%</td>
              <td>{editable ? <button className="secondary" onClick={() => toggle(p)}>{p.active ? 'Ativo' : 'Inativo'}</button> : p.active ? 'Ativo' : 'Inativo'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
