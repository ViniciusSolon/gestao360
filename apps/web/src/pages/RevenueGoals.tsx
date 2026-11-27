import { useState, type FormEvent } from 'react';
import { api, brl, can, toCents, useApi, useSubmit } from '../lib/api';
import { useSession } from '../lib/session';
import { niceScale } from './Marketing';

interface Point { month: string; goalCents: number | null; revenueCents: number }

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const label = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
const longLabel = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
const compact = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });

/**
 * Metas x Receita (linha) dos últimos 12 meses. A meta de cada mês fica guardada,
 * formando o histórico. Receita = leads ganhos no mês (mesma regra do "Valor vendido").
 */
export function RevenueGoals({ pipelineId }: { pipelineId: string }) {
  const { me } = useSession();
  const { data, reload, error } = useApi<Point[]>(`/dashboard/revenue-goals?months=12${pipelineId ? `&pipelineId=${pipelineId}` : ''}`);
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [value, setValue] = useState('');
  const canEdit = can(me.user.role, 'manager');

  const save = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    const cents = value.trim() ? toCents(value) : null;
    if (cents !== null && (!Number.isFinite(cents) || cents < 0)) throw new Error('Valor inválido');
    await api('/dashboard/revenue-goals', { method: 'PUT', body: { month, targetCents: cents } });
    setEditing(false);
    reload();
  });

  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Carregando…</p>;

  const W = 720, H = 260, L = 64, R = 16, T = 12, B = 30;
  const { max, ticks } = niceScale(Math.max(1, ...data.flatMap((d) => [d.revenueCents, d.goalCents ?? 0])) / 100);
  const x = (i: number) => L + ((W - L - R) * i) / Math.max(1, data.length - 1);
  const y = (cents: number) => T + (H - T - B) * (1 - cents / 100 / max);
  const revPath = data.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.revenueCents)}`).join(' ');
  // Meta: linha só nos meses que têm meta (quebra onde não tem)
  const goalPath = data.reduce((acc, d, i) => {
    if (d.goalCents === null) return acc;
    const prev = i > 0 && data[i - 1].goalCents !== null;
    return `${acc}${prev ? 'L' : 'M'}${x(i)},${y(d.goalCents)} `;
  }, '');
  const cur = data.at(-1)!;
  const pct = cur.goalCents ? Math.round((cur.revenueCents / cur.goalCents) * 100) : null;
  const openEdit = (m: string) => {
    const g = data.find((d) => d.month === m)?.goalCents;
    setMonth(m);
    setValue(g ? (g / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '');
    setEditing(true);
  };

  return (
    <section className="card goals-card">
      <div className="row between goals-head">
        <div>
          <h2 style={{ margin: 0 }}>Metas x Receita</h2>
          <small className="muted">
            {longLabel(cur.month)}: {brl(cur.revenueCents)} de {cur.goalCents ? brl(cur.goalCents) : 'meta não definida'}
            {pct !== null && <> · <b className={pct >= 100 ? 'good-text' : ''}>{pct}% da meta</b></>}
          </small>
        </div>
        {canEdit && <button type="button" className="secondary" onClick={() => openEdit(thisMonth)}>Definir meta do mês</button>}
      </div>

      <div className="chart" onMouseLeave={() => setTip(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Linha de meta e de receita por mês">
          <g className="axis">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y(t * 100)} y2={y(t * 100)} strokeDasharray={t ? '3 3' : undefined} />
                <text x={L - 8} y={y(t * 100) + 4} textAnchor="end">{compact(t * 100)}</text>
              </g>
            ))}
            {data.map((d, i) => <text key={d.month} className="lbl" x={x(i)} y={H - 8} textAnchor="middle">{label(d.month)}</text>)}
          </g>
          {goalPath && <path d={goalPath} fill="none" stroke="var(--s4)" strokeWidth={2} strokeDasharray="6 4" />}
          <path d={revPath} fill="none" stroke="var(--s1)" strokeWidth={2.5} />
          {data.map((d, i) => (
            <g key={d.month}>
              {d.goalCents !== null && <circle cx={x(i)} cy={y(d.goalCents)} r={3.5} fill="var(--s4)" />}
              <circle cx={x(i)} cy={y(d.revenueCents)} r={4} fill="var(--s1)" stroke="var(--surface)" strokeWidth={2} />
              {/* Área de toque/hover do mês inteiro */}
              <rect x={x(i) - (W - L - R) / data.length / 2} y={T} width={(W - L - R) / data.length} height={H - T - B} fill="transparent"
                style={{ cursor: canEdit ? 'pointer' : 'default' }}
                onClick={() => canEdit && openEdit(d.month)}
                onMouseMove={(e) => {
                  const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setTip({ i, x: ((x(i)) / W) * box.width, y: e.clientY - box.top });
                }}>
                <title>{`${longLabel(d.month)} — receita ${brl(d.revenueCents)}${d.goalCents !== null ? `, meta ${brl(d.goalCents)}` : ''}`}</title>
              </rect>
            </g>
          ))}
        </svg>
        {tip && (() => {
          const d = data[tip.i];
          const p = d.goalCents ? Math.round((d.revenueCents / d.goalCents) * 100) : null;
          return (
            <div className="tip" style={{ left: tip.x, top: tip.y }}>
              <b>{longLabel(d.month)}</b><br />
              Receita: {brl(d.revenueCents)}<br />
              Meta: {d.goalCents !== null ? brl(d.goalCents) : '—'}{p !== null ? ` (${p}%)` : ''}
            </div>
          );
        })()}
        <div className="legend">
          <span><i style={{ background: 'var(--s1)' }} />Receita (leads ganhos)</span>
          <span><i style={{ background: 'var(--s4)' }} />Meta</span>
          {canEdit && <span className="muted">Clique num mês para definir a meta dele</span>}
        </div>
      </div>

      {editing && (
        <div className="modal-bg" role="dialog" aria-modal="true" aria-labelledby="goal-title" onClick={() => setEditing(false)}>
          <form className="card modal stack" onClick={(e) => e.stopPropagation()} onSubmit={save.run} style={{ maxWidth: 420 }}>
            <h2 id="goal-title" style={{ margin: 0 }}>Meta de receita</h2>
            <label>Mês<input type="month" required value={month} onChange={(e) => {
              setMonth(e.target.value);
              const g = data.find((d) => d.month === e.target.value)?.goalCents;
              setValue(g ? (g / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '');
            }} /></label>
            <label>Meta (R$)<input inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ex.: 150.000,00" />
              <small className="muted">Deixe em branco para remover a meta deste mês.</small>
            </label>
            {save.error && <div className="error">{save.error}</div>}
            <div className="row">
              <button disabled={save.busy}>{save.busy ? 'Salvando…' : 'Salvar meta'}</button>
              <button type="button" className="secondary" onClick={() => setEditing(false)}>Cancelar</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
