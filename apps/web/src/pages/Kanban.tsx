import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, brl, can, CHANNELS, formatCnpj, maskCnpj, toCents, useApi, useSubmit } from '../lib/api';
import { useSession } from '../lib/session';

interface Stage { id: string; name: string; kind: string; probability: number }
export interface Lead {
  id: string; name: string; company: string | null; cnpj: string | null; stage_id: string; status: string; score: number; is_mql: boolean;
  value_cents: string; owner_name: string | null; channel: string;
}

export function Kanban() {
  const { me } = useSession();
  const stages = useApi<Stage[]>('/stages');
  const leads = useApi<Lead[]>('/leads');
  const [over, setOver] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const move = async (leadId: string, stage: Stage) => {
    const lead = leads.data?.find((l) => l.id === leadId);
    if (!lead || lead.stage_id === stage.id) return;
    let lostReason: string | undefined;
    if (stage.kind === 'lost') {
      lostReason = prompt('Motivo da perda:') ?? undefined;
      if (!lostReason) return;
    }
    // atualização otimista; o servidor é a fonte da verdade
    leads.setData((ls) => ls?.map((l) => (l.id === leadId ? { ...l, stage_id: stage.id } : l)) ?? null);
    try {
      await api(`/leads/${leadId}/move`, { method: 'POST', body: { stageId: stage.id, lostReason } });
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
    leads.reload();
  };

  // Busca por nome, empresa ou CNPJ (com ou sem máscara)
  const qCnpj = q.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const visible = (leads.data ?? []).filter(
    (l) =>
      !q ||
      `${l.name} ${l.company ?? ''}`.toLowerCase().includes(q.toLowerCase()) ||
      (qCnpj.length >= 3 && !!l.cnpj?.includes(qCnpj)),
  );

  return (
    <div>
      <div className="row between">
        <h1>Funil comercial</h1>
        <div className="row">
          <input placeholder="Buscar nome, empresa ou CNPJ…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
          <button onClick={() => setCreating(true)}>+ Novo lead</button>
          {can(me.user.role, 'admin') && <StageAdmin onChange={stages.reload} />}
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="kanban">
        {(stages.data ?? []).map((s) => {
          const items = visible.filter((l) => l.stage_id === s.id);
          const total = items.reduce((a, l) => a + Number(l.value_cents), 0);
          return (
            <div
              key={s.id}
              className={`col ${over === s.id ? 'over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(s.id); }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => { setOver(null); move(e.dataTransfer.getData('text/lead'), s); }}
            >
              <h3><span>{s.name} <span className="muted">({items.length})</span></span><span className="muted">{brl(total)}</span></h3>
              {items.map((l) => (
                <div key={l.id} className="lead" draggable onDragStart={(e) => e.dataTransfer.setData('text/lead', l.id)}>
                  <Link to={`/app/leads/${l.id}`} className="t">{l.name}</Link>
                  <div className="s">{l.company ?? '—'} · {brl(l.value_cents)}</div>
                  {l.cnpj && <div className="s cnpj">CNPJ {formatCnpj(l.cnpj)}</div>}
                  <div className="s row">
                    <span>Score {l.score}</span>{l.is_mql && <span className="badge">MQL</span>}<span>{l.owner_name ?? 'sem responsável'}</span>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {creating && <NewLead onClose={() => setCreating(false)} onCreated={() => { setCreating(false); leads.reload(); }} />}
    </div>
  );
}

function NewLead({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ name: '', company: '', cnpj: '', email: '', phone: '', channel: 'site', value: '', expectedCloseDate: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    await api('/leads', {
      method: 'POST',
      body: {
        name: f.name, company: f.company || null, cnpj: f.cnpj || null, email: f.email || null, phone: f.phone || null, channel: f.channel,
        valueCents: f.value ? toCents(f.value) : 0, expectedCloseDate: f.expectedCloseDate || null,
      },
    });
    onCreated();
  });
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="card modal stack" onClick={(e) => e.stopPropagation()} onSubmit={submit.run}>
        <h2 style={{ marginTop: 0 }}>Novo lead</h2>
        <div className="form-grid">
          <label>Nome*<input required value={f.name} onChange={set('name')} /></label>
          <label>Empresa<input value={f.company} onChange={set('company')} /></label>
          <label>CNPJ<input value={f.cnpj} onChange={(e) => setF({ ...f, cnpj: maskCnpj(e.target.value) })} placeholder="00.000.000/0000-00" autoComplete="off" /></label>
          <label>E-mail<input type="email" value={f.email} onChange={set('email')} /></label>
          <label>Telefone<input value={f.phone} onChange={set('phone')} /></label>
          <label>Canal<select value={f.channel} onChange={set('channel')}>{Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Valor estimado (R$)<input inputMode="decimal" value={f.value} onChange={set('value')} placeholder="0,00" /></label>
          <label>Previsão de fechamento<input type="date" value={f.expectedCloseDate} onChange={set('expectedCloseDate')} /></label>
        </div>
        {submit.error && <div className="error">{submit.error}</div>}
        <div className="row"><button disabled={submit.busy}>Salvar</button><button type="button" className="secondary" onClick={onClose}>Cancelar</button></div>
      </form>
    </div>
  );
}

function StageAdmin({ onChange }: { onChange: () => void }) {
  const submit = useSubmit(async () => {
    const name = prompt('Nome da nova etapa:');
    if (!name) return;
    const probability = Number(prompt('Probabilidade de fechamento (0-100):', '50'));
    await api('/stages', { method: 'POST', body: { name, probability: Number.isFinite(probability) ? probability : 0 } });
    onChange();
  });
  return <button className="secondary" disabled={submit.busy} onClick={() => submit.run()} title={submit.error ?? ''}>+ Etapa</button>;
}
