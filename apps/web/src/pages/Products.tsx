import { useRef, useState, type FormEvent } from 'react';
import { api, ApiError, brl, can, toCents, useApi, useSubmit } from '../lib/api';
import { useSession } from '../lib/session';

interface Product {
  id: string; sku: string; name: string; ncm: string | null; price_cents: string; tax_rate_bp: number;
  photo_url: string | null; image_updated_at: string | null; active: boolean;
}

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * Foto grande (celular tira de 4 a 10 MB) é reduzida no navegador para no máximo
 * 1600 px e JPEG, antes de enviar. O servidor confere de novo tamanho e formato.
 */
async function prepareImage(file: File): Promise<Blob> {
  if (!ACCEPT.split(',').includes(file.type)) throw new Error('Use uma imagem JPEG, PNG ou WebP.');
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('Não foi possível ler esta imagem.');
  const MAX = 1600;
  if (file.size <= MAX_BYTES && bmp.width <= MAX && bmp.height <= MAX) return file;
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // PNG transparente vira fundo branco no JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.7, 0.55]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error('A imagem continua grande demais mesmo reduzida (máx. 2 MB).');
}

async function uploadImage(productId: string, file: File) {
  const blob = await prepareImage(file);
  const res = await fetch(`/api/products/${productId}/image`, {
    method: 'PUT', credentials: 'include', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob,
  });
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    throw new ApiError(res.status, d?.error ?? 'error', res.status === 413 ? 'Imagem maior que 2 MB.' : d?.message ?? `Erro ${res.status}`);
  }
}

const imageSrc = (p: Product) =>
  p.image_updated_at ? `/api/products/${p.id}/image?v=${encodeURIComponent(p.image_updated_at)}` : p.photo_url;

export function Products() {
  const { me } = useSession();
  const { data, reload } = useApi<Product[]>('/products');
  const empty = { sku: '', name: '', price: '', ncm: '', taxPercent: '0' };
  const [f, setF] = useState(empty);
  const [newFile, setNewFile] = useState<File | null>(null);
  const [newPreview, setNewPreview] = useState<string | null>(null);
  const newInput = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  // Prévia via data: (a CSP do site já permite; não precisa liberar blob:)
  const pickNew = (file: File | undefined) => {
    setNewFile(file ?? null);
    setNewPreview(null);
    if (!file) return;
    const r = new FileReader();
    r.onload = () => setNewPreview(typeof r.result === 'string' ? r.result : null);
    r.readAsDataURL(file);
  };
  const submit = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    const p = await api<Product>('/products', {
      method: 'POST',
      body: { sku: f.sku, name: f.name, priceCents: toCents(f.price), ncm: f.ncm || null, taxRateBp: Math.round(Number(f.taxPercent.replace(',', '.')) * 100) },
    });
    setF(empty);
    try {
      if (newFile) await uploadImage(p.id, newFile);
    } finally {
      pickNew(undefined);
      if (newInput.current) newInput.current.value = '';
      reload();
    }
  });
  const toggle = async (p: Product) => { await api(`/products/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); reload(); };
  const editable = can(me.user.role, 'manager');

  return (
    <div>
      <h1>Catálogo de produtos</h1>
      {editable && (
        <form className="card form-grid" onSubmit={submit.run} style={{ marginBottom: '1rem' }}>
          <div className="photo-field">
            <span className="photo-label">Foto</span>
            <button type="button" className="photo-drop" onClick={() => newInput.current?.click()} aria-label={newFile ? 'Trocar foto' : 'Escolher foto do produto'}>
              {newPreview ? <img src={newPreview} alt="" /> : <span>+ Foto</span>}
            </button>
            <input ref={newInput} type="file" accept={ACCEPT} hidden onChange={(e) => pickNew(e.target.files?.[0])} />
          </div>
          <label>SKU<input required value={f.sku} onChange={set('sku')} /></label>
          <label>Nome<input required value={f.name} onChange={set('name')} /></label>
          <label>Preço (R$)<input required inputMode="decimal" value={f.price} onChange={set('price')} /></label>
          <label>NCM<input pattern="[0-9]{8}" value={f.ncm} onChange={set('ncm')} placeholder="8 dígitos" /></label>
          <label>Tributos estimados (%)<input inputMode="decimal" value={f.taxPercent} onChange={set('taxPercent')} /></label>
          <div className="row" style={{ alignSelf: 'end' }}><button disabled={submit.busy}>{submit.busy ? 'Salvando…' : 'Adicionar'}</button></div>
          {submit.error && <div className="error">{submit.error}</div>}
        </form>
      )}
      <table>
        <thead><tr><th>Foto</th><th>SKU</th><th>Produto</th><th>NCM</th><th className="num">Preço</th><th className="num">Tributos</th><th>Status</th></tr></thead>
        <tbody>
          {(data ?? []).map((p) => (
            <tr key={p.id}>
              <td><ProductPhoto p={p} editable={editable} onChanged={reload} /></td>
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

/** Miniatura clicável: abre o seletor de arquivo e já envia. */
function ProductPhoto({ p, editable, onChanged }: { p: Product; editable: boolean; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const src = imageSrc(p);
  const up = useSubmit(async (file: File) => {
    await uploadImage(p.id, file);
    onChanged();
  });
  const remove = useSubmit(async () => {
    await api(`/products/${p.id}/image`, { method: 'DELETE' });
    onChanged();
  });
  const img = src ? <img src={src} alt="" referrerPolicy="no-referrer" /> : <span aria-hidden>{editable ? '+' : '—'}</span>;
  if (!editable) return <div className="thumb">{img}</div>;
  return (
    <div className="thumb-wrap">
      <button type="button" className={`thumb ${up.busy ? 'busy' : ''}`} disabled={up.busy}
        onClick={() => input.current?.click()} title={src ? 'Clique para trocar a foto' : 'Clique para enviar uma foto'}
        aria-label={`${src ? 'Trocar' : 'Enviar'} foto de ${p.name}`}>
        {img}
      </button>
      <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) up.run(f); }} />
      {p.image_updated_at && (
        <button type="button" className="icon-btn" aria-label={`Remover foto de ${p.name}`} title="Remover foto"
          disabled={remove.busy} onClick={() => confirm('Remover a foto deste produto?') && remove.run()}>×</button>
      )}
      {(up.error || remove.error) && <div className="error thumb-err">{up.error ?? remove.error}</div>}
    </div>
  );
}
