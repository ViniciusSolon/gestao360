import { useState } from 'react';
import { brl, CHANNELS, useApi } from '../lib/api';

interface Kpi { value: number; origin: string }
interface Dash {
  period: { scope: string };
  kpis: Record<'leads' | 'mqls' | 'wonCount' | 'wonValueCents' | 'avgTicketCents' | 'conversionRate' | 'salesCycleDays' | 'forecastCents', Kpi>;
  revenueBySeller: { seller: string; won: number; valueCents: number }[];
  byChannel: { channel: string; leads: number; won: number; valueCents: number }[];
  funnel: { stageId: string; name: string; kind: string; pipeline: string; leads: number; valueCents: number }[];
  alerts: { stalledLeads: number; overdueActivities: number };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function Dashboard() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86400000)));
  const [to, setTo] = useState(iso(new Date()));
  const { data, error } = useApi<Dash>(`/dashboard?from=${from}&to=${to}`);
  if (error) return <div className="error">{error.message}</div>;
  if (!data) return <div className="muted">Carregando…</div>;
  const k = data.kpis;
  const cards: [string, string, Kpi][] = [
    ['Leads captados', String(k.leads.value), k.leads],
    ['MQLs', String(k.mqls.value), k.mqls],
    ['Negócios ganhos', String(k.wonCount.value), k.wonCount],
    ['Valor vendido', brl(k.wonValueCents.value), k.wonValueCents],
    ['Ticket médio', brl(k.avgTicketCents.value), k.avgTicketCents],
    ['Conversão', `${(k.conversionRate.value * 100).toFixed(1)}%`, k.conversionRate],
    ['Ciclo de vendas', `${k.salesCycleDays.value} dias`, k.salesCycleDays],
    ['Previsão (pipeline)', brl(k.forecastCents.value), k.forecastCents],
  ];
  const maxFunnel = Math.max(1, ...data.funnel.map((f) => f.leads));
  return (
    <div>
      <div className="row between">
        <h1>Comercial <span className="muted" style={{ fontSize: '.9rem' }}>({data.period.scope})</span></h1>
        <div className="row">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 160 }} />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 160 }} />
        </div>
      </div>
      {(data.alerts.stalledLeads > 0 || data.alerts.overdueActivities > 0) && (
        <div className="banner">
          {data.alerts.stalledLeads} oportunidade(s) parada(s) há mais de 14 dias · {data.alerts.overdueActivities} atividade(s) atrasada(s)
        </div>
      )}
      <div className="grid kpis">
        {cards.map(([label, value, kpi]) => (
          <div className="card kpi" key={label} title={kpi.origin}>
            <div className="label">{label}</div>
            <div className="value">{value}</div>
            <div className="origin">Origem: {kpi.origin}</div>
          </div>
        ))}
      </div>
      <h2>Funil atual</h2>
      <div className="card stack">
        {data.funnel.map((f, i) => (
          <div key={f.stageId} className="stack" style={{ gap: '.4rem' }}>
          {new Set(data.funnel.map((x) => x.pipeline)).size > 1 && data.funnel[i - 1]?.pipeline !== f.pipeline && (
            <div className="muted" style={{ fontWeight: 600, marginTop: i ? '.5rem' : 0 }}>{f.pipeline}</div>
          )}
          <div className="row" style={{ gap: '1rem' }}>
            <div style={{ width: 150 }}>{f.name}</div>
            <div style={{ flex: 1 }}><div className="bar" style={{ width: `${(f.leads / maxFunnel) * 100}%`, minWidth: f.leads ? 6 : 0 }} /></div>
            <div className="num" style={{ width: 160 }}>{f.leads} · {brl(f.valueCents)}</div>
          </div>
          </div>
        ))}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <div>
          <h2>Receita por vendedor</h2>
          <table><thead><tr><th>Vendedor</th><th className="num">Ganhos</th><th className="num">Valor</th></tr></thead>
            <tbody>{data.revenueBySeller.map((r) => <tr key={r.seller}><td>{r.seller}</td><td className="num">{r.won}</td><td className="num">{brl(r.valueCents)}</td></tr>)}
              {!data.revenueBySeller.length && <tr><td colSpan={3} className="muted">Sem vendas no período</td></tr>}</tbody></table>
        </div>
        <div>
          <h2>Por canal</h2>
          <table><thead><tr><th>Canal</th><th className="num">Leads</th><th className="num">Ganhos</th><th className="num">Valor</th></tr></thead>
            <tbody>{data.byChannel.map((r) => <tr key={r.channel}><td>{CHANNELS[r.channel] ?? r.channel}</td><td className="num">{r.leads}</td><td className="num">{r.won}</td><td className="num">{brl(r.valueCents)}</td></tr>)}
              {!data.byChannel.length && <tr><td colSpan={4} className="muted">Sem leads no período</td></tr>}</tbody></table>
        </div>
      </div>
    </div>
  );
}
