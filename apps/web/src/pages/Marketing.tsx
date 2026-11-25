import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { api, brl, can, dateBR, LEGACY_SOURCES, SOURCES, toCents, useApi, useSubmit } from '../lib/api';
import { useSession } from '../lib/session';
import { indicatorTabs } from './Layout';

// ---------------------------------------------------------------------------
// Tipos da resposta de GET /api/marketing
// ---------------------------------------------------------------------------
type MetricKey = 'cost' | 'leads' | 'deals' | 'gains' | 'cpl' | 'cpd' | 'cac' | 'roi';
interface Kpi { key: MetricKey; value: number | null; previous: number | null; goal: number | null; better: 'up' | 'down'; origin: string }
interface Counts { cost: number; leads: number; deals: number; gains: number; lost: number; revenue: number; cpl: number | null; cpd: number | null; cac: number | null; roi: number | null }
interface Prev { leads: number; deals: number; gains: number; lost: number; cost?: number }
interface Campaign extends Counts { campaign: string; previous: Prev }
interface SourceRow extends Counts { source: string; label: string; previous: Prev; campaigns: Campaign[] }
interface MarketingData {
  period: { from: string; to: string; previousFrom: string; previousTo: string; days: number };
  kpis: Kpi[];
  totals: Counts & { previous: Prev };
  bySource: SourceRow[];
}

/** /app e /app/indicadores abrem a primeira aba permitida (Marketing para gerente+). */
export function IndicadoresIndex() {
  const { me } = useSession();
  return <Navigate to={indicatorTabs(me.user.role)[0].to} replace />;
}

const LABEL: Record<MetricKey, string> = { cost: 'Cost', leads: 'Leads', deals: 'Deals', gains: 'Gains', cpl: 'CPL', cpd: 'CPD', cac: 'CAC', roi: 'ROI' };
const TITLE: Record<MetricKey, string> = {
  cost: 'Investimento', leads: 'Leads', deals: 'Oportunidades', gains: 'Negócios ganhos',
  cpl: 'Custo por lead', cpd: 'Custo por oportunidade', cac: 'Custo de aquisição de cliente', roi: 'Retorno sobre o investimento',
};
const MONEY = new Set<MetricKey>(['cost', 'cpl', 'cpd', 'cac']);

const pct = (v: number) => `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
const compactBrl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
function fmt(key: MetricKey, v: number | null): string {
  if (v === null) return '—';
  if (key === 'roi') return pct(v);
  if (MONEY.has(key)) return brl(v);
  return v.toLocaleString('pt-BR');
}

/** Variação contra o período anterior, com seta e cor (verde = melhorou, vermelho = piorou). */
function Delta({ value, previous, better = 'up' }: { value: number | null; previous: number | null | undefined; better?: 'up' | 'down' }) {
  if (value === null || previous === null || previous === undefined) return null;
  if (previous === 0) return value > 0 ? <span className="delta good" title="Não havia no período anterior">novo</span> : null;
  const ch = (value - previous) / Math.abs(previous);
  if (ch === 0) return <span className="delta flat">0%</span>;
  const good = (ch > 0) === (better === 'up');
  return (
    <span className={`delta ${good ? 'good' : 'bad'}`} title={`Período anterior: ${previous.toLocaleString('pt-BR')}`}>
      {ch > 0 ? '↑' : '↓'} {pct(Math.abs(ch))}
    </span>
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function Marketing() {
  const { me } = useSession();
  const today = new Date();
  const [from, setFrom] = useState(iso(new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1))));
  const [to, setTo] = useState(iso(today));
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const { data, error, reload } = useApi<MarketingData>(`/marketing?from=${from}&to=${to}&scope=${scope}`);
  const [goalFor, setGoalFor] = useState<Kpi | null>(null);
  const editable = can(me.user.role, 'manager');

  if (!can(me.user.role, 'manager')) return <Navigate to="/app/indicadores/comercial" replace />;
  return (
    <div>
      <div className="mk-head">
        <div>
          <h1>Marketing</h1>
          <div className="muted" style={{ fontSize: '.9rem' }}>Origem dos leads, investimento e retorno por fonte</div>
        </div>
        <div className="mk-filters">
          <label className="row" style={{ display: 'flex', gap: '.35rem' }}>
            <span className="muted" style={{ fontSize: '.8rem' }}>De</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="Data inicial" />
          </label>
          <label className="row" style={{ display: 'flex', gap: '.35rem' }}>
            <span className="muted" style={{ fontSize: '.8rem' }}>até</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="Data final" />
          </label>
          <select value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'mine')} aria-label="Responsável">
            <option value="all">Todos os responsáveis</option>
            <option value="mine">Meus + sem responsável</option>
          </select>
        </div>
      </div>
      <div className="mk-legend">
        Leads pela data de criação · Deals pela 1ª proposta · Gains pela data de ganho · Lost pela data de perda · Investimento da empresa toda.
        {data && <> Comparado com {dateBR(data.period.previousFrom)}–{dateBR(data.period.previousTo)}.</>}
      </div>
      {error && <div className="error">{error.message}</div>}
      {!data ? <div className="muted">Carregando…</div> : (
        <>
          <div className="mk-kpis">
            {data.kpis.map((k) => <KpiCard key={k.key} k={k} editable={editable} onEdit={() => setGoalFor(k)} />)}
          </div>
          <div className="mk-charts">
            <div className="card chart"><h3>Leads / Deals / Gains por fonte</h3><StackedBars rows={data.bySource} /></div>
            <div className="card chart"><h3>Leads por fonte</h3><Donut rows={data.bySource} /></div>
          </div>
          <SourceTable data={data} />
          {editable && <SpendPanel from={from} to={to} onChange={reload} />}
        </>
      )}
      {goalFor && data && (
        <GoalModal kpi={goalFor} month={to.slice(0, 7)} onClose={() => setGoalFor(null)} onSaved={() => { setGoalFor(null); reload(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cartões de indicador com meta
// ---------------------------------------------------------------------------
function KpiCard({ k, editable, onEdit }: { k: Kpi; editable: boolean; onEdit: () => void }) {
  const ratio = k.goal && k.value !== null && k.goal > 0 ? k.value / k.goal : null;
  // Para custo/CPL/CPD/CAC a meta é um TETO: passar dela é ruim
  const over = ratio !== null && k.better === 'down' && ratio > 1;
  const body = (
    <>
      <span className="k" title={`${TITLE[k.key]} — ${k.origin}`}>{LABEL[k.key]}</span>
      <span className="v">{fmt(k.key, k.value)} <Delta value={k.value} previous={k.previous} better={k.better} /></span>
      {k.goal !== null ? (
        <>
          <div className={`progress ${over ? 'over' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, ratio ?? 0) * 100)} aria-label={`${LABEL[k.key]} em relação à meta`}>
            <span style={{ width: `${Math.min(100, (ratio ?? 0) * 100)}%` }} />
          </div>
          <span className="g">
            {ratio !== null ? `${pct(ratio)} · ` : ''}Meta{k.better === 'down' ? ' (máx.)' : ''}: {MONEY.has(k.key) ? compactBrl(k.goal) : k.key === 'roi' ? pct(k.goal) : k.goal.toLocaleString('pt-BR')}
          </span>
        </>
      ) : <span className="g">Sem meta definida</span>}
    </>
  );
  return editable ? (
    <button type="button" className={`mk-kpi editable ${k.goal !== null ? 'has-goal' : ''}`} onClick={onEdit} title={`${TITLE[k.key]}: ${k.origin}. Clique para definir a meta.`}>
      {body}
    </button>
  ) : <div className={`mk-kpi ${k.goal !== null ? 'has-goal' : ''}`}>{body}</div>;
}

function GoalModal({ kpi, month, onClose, onSaved }: { kpi: Kpi; month: string; onClose: () => void; onSaved: () => void }) {
  const initial = kpi.goal === null ? '' : MONEY.has(kpi.key) ? (kpi.goal / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : kpi.key === 'roi' ? String(kpi.goal * 100) : String(kpi.goal);
  const [v, setV] = useState(initial);
  const [m, setM] = useState(month);
  const save = useSubmit(async (target: number | null) => {
    await api('/marketing/goals', { method: 'PUT', body: { metric: kpi.key, month: m, target } });
    onSaved();
  });
  const parse = (): number | null => {
    if (MONEY.has(kpi.key)) return toCents(v);
    const n = Number(v.replace(',', '.'));
    if (!Number.isFinite(n)) return NaN;
    return kpi.key === 'roi' ? n / 100 : Math.round(n);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const t = parse();
    if (t === null || Number.isNaN(t)) { save.setError('Valor inválido'); return; }
    save.run(t);
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <form className="card modal stack" onClick={(e) => e.stopPropagation()} onSubmit={onSubmit}>
        <h2 style={{ marginTop: 0 }}>Meta de {TITLE[kpi.key]} ({LABEL[kpi.key]})</h2>
        <p className="muted" style={{ margin: 0, fontSize: '.85rem' }}>
          {kpi.better === 'down' ? 'É um teto: o ideal é ficar abaixo.' : 'O ideal é alcançar ou passar.'}{' '}
          {['cost', 'leads', 'deals', 'gains'].includes(kpi.key) ? 'Em períodos de vários meses, as metas mensais são somadas.' : 'Vale a meta do mês final do período.'}
        </p>
        <div className="form-grid">
          <label>Mês<input type="month" required value={m} onChange={(e) => setM(e.target.value)} /></label>
          <label>
            {MONEY.has(kpi.key) ? 'Valor (R$)' : kpi.key === 'roi' ? 'ROI (%)' : 'Quantidade'}
            <input required autoFocus inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} />
          </label>
        </div>
        {save.error && <div className="error">{save.error}</div>}
        <div className="row">
          <button disabled={save.busy}>Salvar meta</button>
          {kpi.goal !== null && <button type="button" className="secondary" disabled={save.busy} onClick={() => save.run(null)}>Remover meta</button>}
          <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gráficos (SVG): cores em ordem fixa, legenda sempre, tooltip no hover,
// 2px entre segmentos; a tabela abaixo traz os mesmos números (acessível).
// ---------------------------------------------------------------------------
const SERIES = [
  { key: 'leads', label: 'Leads', color: 'var(--s1)' },
  { key: 'deals', label: 'Deals', color: 'var(--s2)' },
  { key: 'gains', label: 'Gains', color: 'var(--s3)' },
] as const;

/** Escala com passos redondos (1, 2 ou 5 × 10ⁿ) e no máximo ~5 marcas inteiras. */
function niceScale(v: number) {
  const raw = Math.max(1, v) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw) ?? 10 * p);
  const max = Math.ceil(Math.max(1, v) / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}

function StackedBars({ rows }: { rows: SourceRow[] }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const data = rows.filter((r) => r.leads + r.deals + r.gains > 0).slice(0, 8);
  if (!data.length) return <div className="muted" style={{ padding: '2rem 0' }}>Sem leads no período.</div>;
  const W = 560, H = 240, L = 36, B = 34, T = 8;
  const { max, ticks } = niceScale(Math.max(...data.map((r) => r.leads + r.deals + r.gains)));
  const slot = (W - L) / data.length;
  const bw = Math.min(64, slot * 0.6);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  return (
    <div className="chart" onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Leads, deals e ganhos empilhados por fonte">
        <g className="axis">
          {ticks.map((t) => (
            <g key={t}><line x1={L} x2={W} y1={y(t)} y2={y(t)} strokeDasharray={t ? '3 3' : undefined} /><text x={L - 6} y={y(t) + 4} textAnchor="end">{t}</text></g>
          ))}
        </g>
        {data.map((r, i) => {
          const cx = L + slot * i + slot / 2;
          let acc = 0;
          return (
            <g key={r.source}>
              {SERIES.map((s) => {
                const v = r[s.key];
                if (!v) return null;
                const y0 = y(acc), y1 = y(acc + v);
                acc += v;
                const h = Math.max(0, y0 - y1 - 2); // 2px entre segmentos
                return (
                  <rect key={s.key} x={cx - bw / 2} y={y1} width={bw} height={h} rx={3} fill={s.color}
                    onMouseMove={(e) => {
                      const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                      setTip({ x: e.clientX - box.left, y: e.clientY - box.top, text: `${r.label} · ${s.label}: ${v}` });
                    }}>
                    <title>{`${r.label} — ${s.label}: ${v}`}</title>
                  </rect>
                );
              })}
              <text className="lbl" x={cx} y={H - B + 16} textAnchor="middle">{r.label.length > 14 ? `${r.label.slice(0, 13)}…` : r.label}</text>
            </g>
          );
        })}
      </svg>
      {tip && <div className="tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
      <div className="legend">{SERIES.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
    </div>
  );
}

function Donut({ rows }: { rows: SourceRow[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const withLeads = rows.filter((r) => r.leads > 0).sort((a, b) => b.leads - a.leads);
  const total = withLeads.reduce((s, r) => s + r.leads, 0);
  if (!total) return <div className="muted" style={{ padding: '2rem 0' }}>Sem leads no período.</div>;
  // Até 7 fatias com cor própria; o resto vira "Outras" (cinza) — nunca se inventa cor
  const top = withLeads.slice(0, 7);
  const rest = withLeads.slice(7).reduce((s, r) => s + r.leads, 0);
  const slices = [...top.map((r, i) => ({ key: r.source, label: r.label, value: r.leads, color: `var(--s${i + 1})` })),
    ...(rest ? [{ key: '__outras', label: 'Outras', value: rest, color: 'var(--s-other)' }] : [])];
  const R = 80, r = 50, C = 100;
  let a0 = -Math.PI / 2;
  const arcs = slices.map((s) => {
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${C + rad * Math.cos(a)} ${C + rad * Math.sin(a)}`;
    const d = slices.length === 1
      ? `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${C - 0.01} ${C - R} L ${C - 0.01} ${C - r} A ${r} ${r} 0 1 0 ${C} ${C - r} Z`
      : `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`;
    a0 = a1;
    return { ...s, d };
  });
  const active = arcs.find((x) => x.key === hover);
  return (
    <div className="chart" style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 220px) 1fr', gap: '1rem', alignItems: 'center' }}>
      <svg viewBox="0 0 200 200" role="img" aria-label="Distribuição dos leads por fonte">
        {arcs.map((s) => (
          <path key={s.key} d={s.d} fill={s.color} stroke="var(--surface)" strokeWidth={2}
            opacity={hover && hover !== s.key ? 0.45 : 1} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}>
            <title>{`${s.label}: ${s.value} (${pct(s.value / total)})`}</title>
          </path>
        ))}
        <text x={C} y={C - 2} textAnchor="middle" style={{ fontSize: 22, fontWeight: 700, fill: 'var(--text)' }}>{active ? active.value : total}</text>
        <text x={C} y={C + 16} textAnchor="middle" className="lbl">{active ? active.label : 'leads'}</text>
      </svg>
      <ul className="legend" style={{ display: 'grid', gap: '.35rem', listStyle: 'none', padding: 0, margin: 0 }}>
        {arcs.map((s) => (
          <li key={s.key} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)} style={{ color: 'var(--text)' }}>
            <i style={{ background: s.color }} />{s.label} <span className="muted">· {s.value} · {pct(s.value / total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabela "Marketing por fonte" (com campanhas expansíveis)
// ---------------------------------------------------------------------------
function SourceTable({ data }: { data: MarketingData }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const Cells = ({ r, prev }: { r: Counts; prev?: Prev }) => (
    <>
      <td className="num">{brl(r.cost)}</td>
      <td className="num">{r.cpl === null ? '—' : brl(r.cpl)}</td>
      <td className="num">{r.cpd === null ? '—' : brl(r.cpd)}</td>
      <td className="num">{r.lost}<small><Delta value={r.lost} previous={prev?.lost} better="down" /></small></td>
      <td className="num">{r.leads}<small><Delta value={r.leads} previous={prev?.leads} /></small></td>
      <td className="num">{r.deals}<small><Delta value={r.deals} previous={prev?.deals} /></small></td>
      <td className="num">{r.gains}<small><Delta value={r.gains} previous={prev?.gains} /></small></td>
      <td className="num">{r.cac === null ? '—' : brl(r.cac)}</td>
      <td className="num">{r.roi === null ? '—' : pct(r.roi)}</td>
    </>
  );
  return (
    <div className="card mk-table">
      <h2 style={{ marginTop: 0 }}>Marketing por fonte</h2>
      <table>
        <thead>
          <tr><th>Fonte</th><th className="num">Cost</th><th className="num">CPL</th><th className="num">CPD</th><th className="num">Lost</th>
            <th className="num">Lead</th><th className="num">Deal</th><th className="num">Gain</th><th className="num">CAC</th><th className="num">ROI</th></tr>
        </thead>
        <tbody>
          <tr className="total"><td>TOTAL</td><Cells r={data.totals} prev={data.totals.previous} /></tr>
          {data.bySource.map((r) => (
            <Fragment key={r.source}>
              <tr>
                <td>
                  {r.campaigns.length ? (
                    <button className="expand" aria-expanded={open.has(r.source)} aria-label={`Campanhas de ${r.label}`} onClick={() => toggle(r.source)}>
                      {open.has(r.source) ? '▾' : '▸'}
                    </button>
                  ) : <span style={{ display: 'inline-block', width: '1.2rem' }} />}
                  {r.label}{r.campaigns.length ? <span className="muted"> ({r.campaigns.length})</span> : null}
                </td>
                <Cells r={r} prev={r.previous} />
              </tr>
              {open.has(r.source) && r.campaigns.map((c) => (
                <tr key={c.campaign} className="camp"><td>{c.campaign}</td><Cells r={c} prev={c.previous} /></tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lançamento de investimento (custo) por fonte
// ---------------------------------------------------------------------------
function SpendPanel({ from, to, onChange }: { from: string; to: string; onChange: () => void }) {
  const list = useApi<any[]>(`/marketing/spend?from=${from}&to=${to}`);
  const [f, setF] = useState({ source: 'google_ads', campaign: '', spentOn: to, amount: '' });
  const add = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    const amountCents = toCents(f.amount);
    if (!Number.isFinite(amountCents)) throw new Error('Valor inválido');
    await api('/marketing/spend', { method: 'POST', body: { source: f.source, campaign: f.campaign || null, spentOn: f.spentOn, amountCents } });
    setF({ ...f, amount: '', campaign: '' });
    list.reload();
    onChange();
  });
  const del = useSubmit(async (id: string) => {
    await api(`/marketing/spend/${id}`, { method: 'DELETE' });
    list.reload();
    onChange();
  });
  const total = useMemo(() => (list.data ?? []).reduce((s, x) => s + x.amount_cents, 0), [list.data]);
  return (
    <div className="card mk-spend stack">
      <h2 style={{ margin: 0 }}>Investimento por fonte</h2>
      <p className="muted" style={{ margin: 0, fontSize: '.85rem' }}>
        Lance quanto foi gasto em cada fonte (ex.: fatura do Google Ads do mês). O custo entra no período pela data do lançamento.
      </p>
      <form className="form-grid" onSubmit={add.run}>
        <label>Fonte
          <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            {SOURCES.filter(([k]) => !LEGACY_SOURCES.has(k) && k !== 'outro').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Campanha (opcional)<input value={f.campaign} onChange={(e) => setF({ ...f, campaign: e.target.value })} placeholder="Ex.: Black Friday" /></label>
        <label>Data<input type="date" required value={f.spentOn} onChange={(e) => setF({ ...f, spentOn: e.target.value })} /></label>
        <label>Valor (R$)<input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0,00" /></label>
        <div className="row" style={{ alignSelf: 'end' }}><button disabled={add.busy}>Lançar</button></div>
        {add.error && <div className="error" style={{ gridColumn: '1/-1' }}>{add.error}</div>}
      </form>
      <table>
        <thead><tr><th>Data</th><th>Fonte</th><th>Campanha</th><th className="num">Valor</th><th>Lançado por</th><th /></tr></thead>
        <tbody>
          {(list.data ?? []).map((x) => (
            <tr key={x.id}>
              <td>{dateBR(`${x.spent_on}T12:00:00`)}</td><td>{x.label}</td><td>{x.campaign ?? '—'}</td>
              <td className="num">{brl(x.amount_cents)}</td><td>{x.created_by_name ?? '—'}</td>
              <td><button className="secondary" disabled={del.busy} onClick={() => { if (confirm('Remover este lançamento?')) del.run(x.id); }}>Remover</button></td>
            </tr>
          ))}
          {list.data && !list.data.length && <tr><td colSpan={6} className="muted">Nenhum investimento lançado no período.</td></tr>}
          {list.data && list.data.length > 0 && <tr className="total"><td colSpan={3}>Total no período</td><td className="num">{brl(total)}</td><td colSpan={2} /></tr>}
        </tbody>
      </table>
      {del.error && <div className="error">{del.error}</div>}
    </div>
  );
}
