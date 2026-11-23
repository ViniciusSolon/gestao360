import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dateTimeBR, useApi } from '../lib/api';

export function Activities() {
  const [open, setOpen] = useState<'true' | 'false' | ''>('true');
  const [mine, setMine] = useState(true);
  const { data, reload, error } = useApi<any[]>(`/activities?${open ? `open=${open}&` : ''}mine=${mine}`);
  const [busy, setBusy] = useState<string | null>(null);
  const complete = async (id: string) => {
    setBusy(id); // UX: evita clique duplo; o servidor já é idempotente
    try { await api(`/activities/${id}/complete`, { method: 'POST' }); } finally { setBusy(null); reload(); }
  };
  return (
    <div>
      <div className="row between">
        <h1>Agenda</h1>
        <div className="row">
          <select value={open} onChange={(e) => setOpen(e.target.value as any)} style={{ width: 160 }}>
            <option value="true">Abertas</option><option value="false">Concluídas</option><option value="">Todas</option>
          </select>
          <label className="row" style={{ display: 'flex' }}><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} style={{ width: 'auto' }} /> Só minhas</label>
        </div>
      </div>
      {error && <div className="error">{error.message}</div>}
      <table>
        <thead><tr><th>Quando</th><th>Atividade</th><th>Lead</th><th>Responsável</th><th /></tr></thead>
        <tbody>
          {(data ?? []).map((a) => {
            const late = !a.done_at && a.due_at && new Date(a.due_at) < new Date();
            return (
              <tr key={a.id}>
                <td style={{ color: late ? 'var(--danger)' : undefined }}>{dateTimeBR(a.due_at)}</td>
                <td>{a.title} <span className="muted">({a.type})</span>{a.meeting_url && <> · <a href={a.meeting_url} target="_blank" rel="noopener noreferrer">entrar</a></>}</td>
                <td>{a.lead_id ? <Link to={`/app/leads/${a.lead_id}`}>{a.lead_name}</Link> : '—'}</td>
                <td>{a.assigned_name}</td>
                <td>{a.done_at ? <span className="badge won">feita</span> : <button className="secondary" disabled={busy === a.id} onClick={() => complete(a.id)}>Concluir</button>}</td>
              </tr>
            );
          })}
          {data && !data.length && <tr><td colSpan={5} className="muted">Nada por aqui</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
