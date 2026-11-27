import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, brl, can, formatCnpj, LEGACY_SOURCES, SOURCES, maskCnpj, toCents, useApi, useSubmit } from '../lib/api';
import { useSession } from '../lib/session';

interface Stage { id: string; pipeline_id: string; name: string; kind: string; probability: number }
interface Pipeline { id: string; name: string; stages: Stage[] }
export interface Lead {
  id: string; name: string; company: string | null; cnpj: string | null; stage_id: string; status: string; score: number; is_mql: boolean;
  value_cents: string; owner_name: string | null; channel: string;
}

export function Kanban() {
  const { me } = useSession();
  const pipes = useApi<Pipeline[]>('/pipelines');
  const leads = useApi<Lead[]>('/leads');
  const [over, setOver] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<Pipeline | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const isAdmin = can(me.user.role, 'admin');

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

  /** Ações de administrador (funil/etapa). Mostra o erro do servidor (ex.: etapa com leads). */
  const admin = useSubmit(async (fn: () => Promise<unknown>) => {
    await fn();
    await pipes.reload();
  });
  const newPipeline = () => {
    const name = prompt('Nome do novo funil (ex.: Pós-venda, Parcerias):')?.trim();
    if (name) admin.run(() => api('/pipelines', { method: 'POST', body: { name } }));
  };
  const renamePipeline = (p: Pipeline) => {
    const name = prompt('Novo nome do funil:', p.name)?.trim();
    if (name && name !== p.name) admin.run(() => api(`/pipelines/${p.id}`, { method: 'PATCH', body: { name } }));
  };
  const deletePipeline = (p: Pipeline) => {
    if (confirm(`Excluir o funil "${p.name}" e as etapas dele? (só funciona se não houver leads nele)`)) admin.run(() => api(`/pipelines/${p.id}`, { method: 'DELETE' }));
  };
  const newStage = (p: Pipeline) => {
    const name = prompt(`Nome da nova etapa em "${p.name}":`)?.trim();
    if (!name) return;
    const probability = Number(prompt('Probabilidade de fechamento (0-100):', '50'));
    admin.run(() => api('/stages', { method: 'POST', body: { name, pipelineId: p.id, probability: Number.isFinite(probability) ? Math.min(100, Math.max(0, Math.round(probability))) : 0 } }));
  };
  const deleteStage = (s: Stage, count: number) => {
    if (count > 0) { admin.setError(`A etapa "${s.name}" tem ${count} lead(s). Mova-os para outra etapa antes de excluir.`); return; }
    if (confirm(`Excluir a etapa "${s.name}"?`)) admin.run(() => api(`/stages/${s.id}`, { method: 'DELETE' }));
  };

  // Busca por nome, empresa ou CNPJ (com ou sem máscara)
  const qCnpj = q.toUpperCase().replace(/[^0-9A-Z]/g, '');
  const visible = (leads.data ?? []).filter(
    (l) =>
      !q ||
      `${l.name} ${l.company ?? ''}`.toLowerCase().includes(q.toLowerCase()) ||
      (qCnpj.length >= 3 && !!l.cnpj?.includes(qCnpj)),
  );
  const all = pipes.data ?? [];

  return (
    <div>
      <div className="row between">
        <h1>Funil comercial</h1>
        <div className="row">
          <input placeholder="Nome, empresa ou CNPJ" aria-label="Buscar por nome, empresa ou CNPJ" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
          <button onClick={() => all[0] && setCreatingIn(all[0])}>+ Novo lead</button>
        </div>
      </div>
      {(err || admin.error) && <div className="error" role="alert">{err ?? admin.error}</div>}
      {all.map((p) => {
        const firstOpen = p.stages.find((s) => s.kind === 'open');
        return (
          <section key={p.id} className="pipeline" aria-labelledby={`pl-${p.id}`}>
            {(all.length > 1 || isAdmin) && (
              <div className="pipeline-head">
                <h2 id={`pl-${p.id}`}>{p.name}</h2>
                <div className="row">
                  {all.length > 1 && firstOpen && <button className="secondary sm" onClick={() => setCreatingIn(p)}>+ Lead aqui</button>}
                  {isAdmin && <>
                    <button className="secondary sm" disabled={admin.busy} onClick={() => newStage(p)}>+ Etapa</button>
                    <button className="secondary sm" disabled={admin.busy} onClick={() => renamePipeline(p)}>Renomear</button>
                    {all.length > 1 && <button className="secondary sm" disabled={admin.busy} onClick={() => deletePipeline(p)}>Excluir funil</button>}
                  </>}
                </div>
              </div>
            )}
            <div className="kanban">
              {p.stages.map((s) => {
                const items = visible.filter((l) => l.stage_id === s.id);
                const total = items.reduce((a, l) => a + Number(l.value_cents), 0);
                const allInStage = (leads.data ?? []).filter((l) => l.stage_id === s.id).length;
                return (
                  <div
                    key={s.id}
                    className={`col ${over === s.id ? 'over' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setOver(s.id); }}
                    onDragLeave={() => setOver(null)}
                    onDrop={(e) => { setOver(null); move(e.dataTransfer.getData('text/lead'), s); }}
                  >
                    <h3>
                      <span>{s.name} <span className="muted">({items.length})</span></span>
                      <span className="col-tools">
                        <span className="muted">{brl(total)}</span>
                        {isAdmin && (
                          <button type="button" className="icon-btn" aria-label={`Excluir etapa ${s.name}`} title="Excluir etapa"
                            disabled={admin.busy} onClick={() => deleteStage(s, allInStage)}>×</button>
                        )}
                      </span>
                    </h3>
                    {items.map((l) => (
                      <div key={l.id} className="lead" draggable onDragStart={(e) => e.dataTransfer.setData('text/lead', l.id)}>
                        <Link to={`/app/leads/${l.id}`} className="t">{l.name}</Link>
                        <div className="s">{l.company ?? '—'} · {brl(l.value_cents)}</div>
                        {l.cnpj && <div className="s cnpj">CNPJ {formatCnpj(l.cnpj)}</div>}
                        <div className="s row">
                          <span>Score {l.score}</span>{l.is_mql && <span className="badge">MQL</span>}<span>{l.owner_name ?? 'sem responsável'}</span>
                        </div>
                        <Link to={`/app/leads/${l.id}`} className="lead-open" aria-label={`Abrir ${l.name}`} draggable={false}>Abrir →</Link>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {isAdmin && (
        <button type="button" className="add-pipeline" disabled={admin.busy} onClick={newPipeline}>+ Novo funil</button>
      )}
      {creatingIn && (
        <NewLead
          pipelines={all}
          initial={creatingIn}
          onClose={() => setCreatingIn(null)}
          onCreated={() => { setCreatingIn(null); leads.reload(); }}
        />
      )}
    </div>
  );
}

function NewLead({ pipelines, initial, onClose, onCreated }: { pipelines: Pipeline[]; initial: Pipeline; onClose: () => void; onCreated: () => void }) {
  const [pipelineId, setPipelineId] = useState(initial.id);
  const stageId = pipelines.find((p) => p.id === pipelineId)?.stages.find((s) => s.kind === 'open')?.id;
  const [f, setF] = useState({ name: '', company: '', cnpj: '', email: '', phone: '', channel: 'google_ads', campaign: '', value: '', expectedCloseDate: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    await api('/leads', {
      method: 'POST',
      body: {
        name: f.name, company: f.company || null, cnpj: f.cnpj || null, email: f.email || null, phone: f.phone || null, channel: f.channel, campaign: f.campaign || null,
        valueCents: f.value ? toCents(f.value) : 0, expectedCloseDate: f.expectedCloseDate || null, stageId,
      },
    });
    onCreated();
  });
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="card modal stack" onClick={(e) => e.stopPropagation()} onSubmit={submit.run}>
        <h2 style={{ marginTop: 0 }}>Novo lead</h2>
        <div className="form-grid">
          {pipelines.length > 1 && (
            <label>Funil
              <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}>
                {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          )}
          <label>Nome*<input required value={f.name} onChange={set('name')} /></label>
          <label>Empresa<input value={f.company} onChange={set('company')} /></label>
          <label>CNPJ<input value={f.cnpj} onChange={(e) => setF({ ...f, cnpj: maskCnpj(e.target.value) })} placeholder="00.000.000/0000-00" autoComplete="off" /></label>
          <label>E-mail<input type="email" value={f.email} onChange={set('email')} /></label>
          <label>Telefone<input value={f.phone} onChange={set('phone')} /></label>
          <label>Fonte
            <select value={f.channel} onChange={set('channel')}>
              {SOURCES.filter(([k]) => !LEGACY_SOURCES.has(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              <optgroup label="Outras">
                {SOURCES.filter(([k]) => LEGACY_SOURCES.has(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </optgroup>
            </select>
          </label>
          <label>Campanha<input value={f.campaign} onChange={set('campaign')} placeholder="Ex.: Black Friday" /></label>
          <label>Valor estimado (R$)<input inputMode="decimal" value={f.value} onChange={set('value')} placeholder="0,00" /></label>
          <label>Previsão de fechamento<input type="date" value={f.expectedCloseDate} onChange={set('expectedCloseDate')} /></label>
        </div>
        {submit.error && <div className="error">{submit.error}</div>}
        <div className="row"><button disabled={submit.busy}>Salvar</button><button type="button" className="secondary" onClick={onClose}>Cancelar</button></div>
      </form>
    </div>
  );
}
