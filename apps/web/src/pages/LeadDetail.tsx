import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, brl, CHANNELS, dateBR, dateTimeBR, formatCnpj, maskCnpj, useApi, useSubmit } from '../lib/api';

const EVENT_LABEL: Record<string, string> = {
  created: 'Lead criado', updated: 'Dados atualizados', stage_changed: 'Mudou de etapa', activity_created: 'Atividade criada',
  activity_done: 'Atividade concluída', proposal_created: 'Proposta criada', proposal_accepted: 'Proposta aceita',
};

/** CNPJ do lead com edição no lugar. A máscara é só visual; o servidor valida os dígitos. */
function CnpjField({ leadId, value, onSaved }: { leadId: string; value: string | null; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState('');
  const save = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    await api(`/leads/${leadId}`, { method: 'PATCH', body: { cnpj: v || null } });
    setEditing(false);
    onSaved();
  });
  if (!editing) {
    return (
      <div>
        <div className="muted">CNPJ</div>
        {value ? formatCnpj(value) : '—'}{' '}
        <button
          type="button"
          className="secondary"
          aria-label={value ? 'Editar CNPJ' : 'Adicionar CNPJ'}
          style={{ padding: '.1rem .5rem', fontSize: '.8rem' }}
          onClick={() => { setV(formatCnpj(value)); setEditing(true); }}
        >
          {value ? 'Editar' : 'Adicionar'}
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={save.run}>
      <label>CNPJ
        <input autoFocus value={v} onChange={(e) => setV(maskCnpj(e.target.value))} placeholder="00.000.000/0000-00" />
      </label>
      <div className="row" style={{ marginTop: '.4rem' }}>
        <button disabled={save.busy} style={{ padding: '.25rem .6rem' }}>Salvar</button>
        <button type="button" className="secondary" style={{ padding: '.25rem .6rem' }} onClick={() => { setEditing(false); save.setError(null); }}>Cancelar</button>
      </div>
      {save.error && <div className="error">{save.error}</div>}
    </form>
  );
}

export function LeadDetail() {
  const { id } = useParams();
  const { data: lead, error, reload } = useApi<any>(`/leads/${id}`);
  const [act, setAct] = useState({ type: 'call', title: '', dueAt: '', meetingUrl: '' });
  const addActivity = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    await api('/activities', {
      method: 'POST',
      body: { leadId: id, type: act.type, title: act.title, dueAt: act.dueAt ? new Date(act.dueAt).toISOString() : null, meetingUrl: act.meetingUrl || null },
    });
    setAct({ type: 'call', title: '', dueAt: '', meetingUrl: '' });
    reload();
  });
  if (error) return <div className="error">{error.message}</div>;
  if (!lead) return <div className="muted">Carregando…</div>;
  return (
    <div className="stack">
      <div className="row between">
        <h1>{lead.name} <span className={`badge ${lead.status}`}>{lead.status}</span></h1>
        <Link to={`/app/propostas/nova?leadId=${lead.id}`}><button>Nova proposta</button></Link>
      </div>
      <div className="card form-grid">
        <div><div className="muted">Empresa</div>{lead.company ?? '—'}</div>
        <CnpjField leadId={lead.id} value={lead.cnpj} onSaved={reload} />
        <div><div className="muted">E-mail</div>{lead.email ?? '—'}</div>
        <div><div className="muted">Telefone</div>{lead.phone ?? '—'}</div>
        <div><div className="muted">Canal</div>{CHANNELS[lead.channel] ?? lead.channel}</div>
        <div><div className="muted">Valor</div>{brl(lead.value_cents)}</div>
        <div><div className="muted">Pontuação</div>{lead.score} {lead.is_mql && <span className="badge">MQL</span>}</div>
        <div><div className="muted">Previsão</div>{dateBR(lead.expected_close_date)}</div>
        {lead.lost_reason && <div><div className="muted">Motivo da perda</div>{lead.lost_reason}</div>}
      </div>

      <h2>Atividades</h2>
      <form className="card form-grid" onSubmit={addActivity.run}>
        <label>Tipo<select value={act.type} onChange={(e) => setAct({ ...act, type: e.target.value })}>
          <option value="call">Ligação</option><option value="meeting">Reunião</option><option value="task">Tarefa</option><option value="email">E-mail</option><option value="note">Nota</option>
        </select></label>
        <label>Título<input required value={act.title} onChange={(e) => setAct({ ...act, title: e.target.value })} /></label>
        <label>Quando<input type="datetime-local" value={act.dueAt} onChange={(e) => setAct({ ...act, dueAt: e.target.value })} /></label>
        {act.type === 'meeting' && <label>Link da videochamada (https)<input type="url" pattern="https://.*" value={act.meetingUrl} onChange={(e) => setAct({ ...act, meetingUrl: e.target.value })} /></label>}
        <div className="row" style={{ alignSelf: 'end' }}><button disabled={addActivity.busy}>Adicionar</button></div>
        {addActivity.error && <div className="error">{addActivity.error}</div>}
      </form>
      <table><tbody>
        {lead.activities.map((a: any) => <tr key={a.id}><td>{a.title}</td><td>{a.type}</td><td>{dateTimeBR(a.due_at)}</td><td>{a.done_at ? 'concluída' : 'aberta'}</td></tr>)}
        {!lead.activities.length && <tr><td className="muted">Nenhuma atividade</td></tr>}
      </tbody></table>

      <h2>Propostas</h2>
      <table><tbody>
        {lead.proposals.map((p: any) => <tr key={p.id}><td><Link to={`/app/propostas/${p.id}`}>#{p.number}</Link></td><td><span className={`badge ${p.status}`}>{p.status}</span></td><td className="num">{brl(p.total_cents)}</td></tr>)}
        {!lead.proposals.length && <tr><td className="muted">Nenhuma proposta</td></tr>}
      </tbody></table>

      <h2>Histórico</h2>
      <div className="card stack">
        {lead.events.map((e: any) => (
          <div key={e.id} className="row between"><span>{EVENT_LABEL[e.type] ?? e.type}{e.data?.stageName ? `: ${e.data.stageName}` : ''}{e.data?.title ? `: ${e.data.title}` : ''}</span><span className="muted">{e.user_name ?? ''} · {dateTimeBR(e.created_at)}</span></div>
        ))}
      </div>
    </div>
  );
}
