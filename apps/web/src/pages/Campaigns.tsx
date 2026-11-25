import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, can, dateTimeBR, LEGACY_SOURCES, SOURCES, useApi, useSubmit } from '../lib/api';
import { useSession } from '../lib/session';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
export type Channel = 'email' | 'whatsapp' | 'sms';
type Status = 'draft' | 'scheduled' | 'sending' | 'sent' | 'canceled';
interface Stats { total: number; pending: number; sending: number; sent: number; failed: number; skipped: number }
interface Audience { stageIds: string[]; sources: string[]; statuses: string[]; mqlOnly: boolean }
interface CampaignRow {
  id: string; channel: Channel; name: string; status: Status; scheduled_at: string | null; started_at: string | null;
  finished_at: string | null; created_at: string; created_by_name?: string; stats: Stats;
}
interface Campaign extends CampaignRow {
  audience: Audience; content: Record<string, any>;
  recipients: { id: string; lead_id: string; lead_name: string | null; address: string; status: string; error: string | null; sent_at: string | null }[];
}
export interface ChannelInfo {
  channel: Channel; provider: string; configured: boolean; settings: Record<string, string>; secretHint: string | null;
  updatedAt: string | null; serverReady: boolean; mode: 'live' | 'fake';
}
interface Preview { matched: number; reachable: number; missingAddress: number; optedOut: number; duplicates: number; sample: { name: string; address: string }[] }

export const CHANNEL_INFO: Record<Channel, { label: string; icon: string; provider: string; desc: string }> = {
  email: { label: 'E-mail', icon: '✉', provider: 'Resend', desc: 'Newsletters, ofertas e comunicados com link de descadastro automático.' },
  whatsapp: { label: 'WhatsApp', icon: '💬', provider: 'WhatsApp Business (Meta)', desc: 'Mensagens por templates aprovados pela Meta, direto no celular do cliente.' },
  sms: { label: 'SMS', icon: '📱', provider: 'Zenvia', desc: 'Avisos curtos que chegam até sem internet. Só para celulares.' },
};
const STATUS_LABEL: Record<Status, string> = { draft: 'Rascunho', scheduled: 'Agendada', sending: 'Enviando', sent: 'Enviada', canceled: 'Cancelada' };
const RECIPIENT_LABEL: Record<string, string> = { pending: 'Na fila', sending: 'Enviando', sent: 'Enviada', failed: 'Falhou', skipped: 'Não enviada' };
const VARIABLES = [['{{primeiro_nome}}', 'Primeiro nome'], ['{{nome}}', 'Nome completo'], ['{{empresa}}', 'Empresa']];

function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge cp-${status}`}>{STATUS_LABEL[status]}</span>;
}

// ---------------------------------------------------------------------------
// Página inicial de Campanhas
// ---------------------------------------------------------------------------
export function CampaignsHome() {
  const list = useApi<CampaignRow[]>('/campaigns');
  const channels = useApi<ChannelInfo[]>('/channels');
  const { me } = useSession();
  const connected = (ch: Channel) => channels.data?.find((c) => c.channel === ch)?.configured;

  return (
    <div className="cp">
      <h1>Campanhas</h1>
      <section className="cp-hero card">
        <div>
          <h2>Seus clientes nunca estiveram tão próximos</h2>
          <p className="muted">
            Fale com os leads do seu funil por e-mail, WhatsApp e SMS. Escolha quem recebe pelos filtros do funil,
            personalize com o nome de cada pessoa e acompanhe as entregas em tempo real.
          </p>
        </div>
        <div className="cp-hero-art" aria-hidden>
          <span>✉</span><span>💬</span><span>📱</span>
        </div>
      </section>

      <h2>Criar campanha</h2>
      <div className="cp-cards">
        {(Object.keys(CHANNEL_INFO) as Channel[]).map((ch) => (
          <div key={ch} className="card cp-card">
            <div className={`cp-icon cp-icon-${ch}`} aria-hidden>{CHANNEL_INFO[ch].icon}</div>
            <h3>{CHANNEL_INFO[ch].label}</h3>
            <p className="muted">{CHANNEL_INFO[ch].desc}</p>
            <div className="cp-card-foot">
              {channels.data && (connected(ch)
                ? <span className="cp-ok">● Conectado</span>
                : <Link to="/app/marketing/canais" className="cp-warn">○ Conectar {CHANNEL_INFO[ch].provider}</Link>)}
              <Link className="btn" to={`/app/marketing/campanhas/nova?canal=${ch}`}>Criar</Link>
            </div>
          </div>
        ))}
      </div>

      <h2>Suas campanhas</h2>
      {list.loading && !list.data && <p className="muted">Carregando…</p>}
      {list.error && <p className="error">{list.error.message}</p>}
      {list.data && list.data.length === 0 && (
        <p className="muted card">Nenhuma campanha ainda. Escolha um canal acima para criar a primeira.</p>
      )}
      {!!list.data?.length && (
        <div className="cp-table">
          <table>
            <thead>
              <tr><th>Campanha</th><th>Canal</th><th>Situação</th><th className="num">Destinatários</th><th className="num">Enviadas</th><th className="num">Falhas</th><th>Data</th></tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/app/marketing/campanhas/${c.id}`}>{c.name}</Link>{c.created_by_name && <small className="muted"> · {c.created_by_name}</small>}</td>
                  <td>{CHANNEL_INFO[c.channel].label}</td>
                  <td><StatusBadge status={c.status} /></td>
                  <td className="num">{c.status === 'draft' ? '—' : c.stats.total.toLocaleString('pt-BR')}</td>
                  <td className="num">{c.status === 'draft' ? '—' : c.stats.sent.toLocaleString('pt-BR')}</td>
                  <td className="num">{c.status === 'draft' ? '—' : c.stats.failed.toLocaleString('pt-BR')}</td>
                  <td>{dateTimeBR(c.finished_at ?? c.scheduled_at ?? c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!can(me.user.role, 'admin') && channels.data?.some((c) => !c.configured) && (
        <p className="muted cp-note">Para conectar um canal, peça a um administrador da sua empresa.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Criar / editar campanha
// ---------------------------------------------------------------------------
const emptyAudience: Audience = { stageIds: [], sources: [], statuses: [], mqlOnly: false };
const defaultContent = (ch: Channel): Record<string, any> =>
  ch === 'email' ? { subject: '', body: 'Olá, {{primeiro_nome}}!\n\n' }
  : ch === 'sms' ? { text: '' }
  : { template: '', language: 'pt_BR', params: [] as string[] };

/** "2026-11-25T14:30" (hora local) ↔ ISO */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function CampaignEditor() {
  const { id } = useParams();
  const [qs] = useSearchParams();
  const nav = useNavigate();
  const existing = useApi<Campaign>(id ? `/campaigns/${id}` : null);
  const stages = useApi<{ id: string; name: string }[]>('/stages');
  const channels = useApi<ChannelInfo[]>('/channels');

  const initialChannel = (['email', 'whatsapp', 'sms'].includes(qs.get('canal') ?? '') ? qs.get('canal') : 'email') as Channel;
  const [channel, setChannel] = useState<Channel>(initialChannel);
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<Audience>(emptyAudience);
  const [content, setContent] = useState<Record<string, any>>(defaultContent(initialChannel));
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [loaded, setLoaded] = useState(!id);
  // Depois do primeiro "salvar", edita o mesmo rascunho (nunca cria outro)
  const [createdId, setCreatedId] = useState<string | null>(null);
  const draftId = id ?? createdId;

  useEffect(() => {
    const c = existing.data;
    if (!c || loaded) return;
    setChannel(c.channel);
    setName(c.name);
    setAudience({ ...emptyAudience, ...c.audience });
    setContent({ ...defaultContent(c.channel), ...c.content });
    if (c.scheduled_at) { setWhen('later'); setScheduledAt(toLocalInput(c.scheduled_at)); }
    setLoaded(true);
  }, [existing.data, loaded]);

  // Prévia do público (espera o usuário parar de mexer nos filtros)
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      api<Preview>('/campaigns/audience-preview', { method: 'POST', body: { channel, audience } }).then(setPreview).catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [channel, audience, loaded]);

  const channelInfo = channels.data?.find((c) => c.channel === channel);
  const payload = () => ({
    name: name.trim(),
    audience,
    content: channel === 'whatsapp' ? { ...content, params: (content.params as string[]).filter((p) => p.trim() !== '') } : content,
    scheduledAt: when === 'later' && scheduledAt ? new Date(scheduledAt).toISOString() : null,
  });

  const save = useSubmit(async () => {
    if (draftId) return api<Campaign>(`/campaigns/${draftId}`, { method: 'PATCH', body: payload() });
    const c = await api<Campaign>('/campaigns', { method: 'POST', body: { channel, ...payload() } });
    setCreatedId(c.id);
    return c;
  });
  const send = useSubmit(async (campaignId: string) => api(`/campaigns/${campaignId}/send`, { method: 'POST' }));

  const onSaveDraft = async (e: FormEvent) => {
    e.preventDefault();
    const c = await save.run();
    if (c) nav(`/app/marketing/campanhas/${c.id}`);
  };
  const onSend = async () => {
    if (when === 'later' && (!scheduledAt || new Date(scheduledAt) <= new Date())) {
      save.setError('Escolha uma data e hora no futuro para agendar.');
      setConfirm(false);
      return;
    }
    const c = await save.run();
    if (!c) { setConfirm(false); return; }
    const r = await send.run(c.id);
    setConfirm(false);
    if (r) nav(`/app/marketing/campanhas/${c.id}`);
  };

  if (id && existing.error) return <p className="error">{existing.error.message}</p>;
  if (!loaded) return <p className="muted">Carregando…</p>;
  if (existing.data && existing.data.status !== 'draft') {
    return <p>Esta campanha já foi enviada. <Link to={`/app/marketing/campanhas/${id}`}>Ver resultado</Link></p>;
  }

  const toggle = (key: 'stageIds' | 'sources' | 'statuses', v: string) =>
    setAudience((a) => ({ ...a, [key]: a[key].includes(v) ? a[key].filter((x) => x !== v) : [...a[key], v] }));
  const err = save.error ?? send.error;

  return (
    <form className="cp cp-editor" onSubmit={onSaveDraft}>
      <div className="row between">
        <h1>{id ? 'Editar campanha' : 'Nova campanha'} · {CHANNEL_INFO[channel].label}</h1>
        <Link to="/app/marketing/campanhas">Voltar</Link>
      </div>

      {channels.data && !channelInfo?.configured && (
        <div className="banner">
          O canal {CHANNEL_INFO[channel].label} ainda não está conectado. Você pode montar o rascunho agora e
          conectar em <Link to="/app/marketing/canais">Marketing → Canais</Link> antes de enviar.
        </div>
      )}
      {channelInfo?.mode === 'fake' && <div className="banner">Modo de teste: as mensagens são simuladas e não saem de verdade.</div>}

      <section className="card stack">
        {!draftId && (
          <div className="cp-channel-pick" role="radiogroup" aria-label="Canal">
            {(Object.keys(CHANNEL_INFO) as Channel[]).map((ch) => (
              <button key={ch} type="button" role="radio" aria-checked={channel === ch} className={channel === ch ? 'on' : ''}
                onClick={() => { setChannel(ch); setContent(defaultContent(ch)); }}>
                <span aria-hidden>{CHANNEL_INFO[ch].icon}</span> {CHANNEL_INFO[ch].label}
              </button>
            ))}
          </div>
        )}
        <label>Nome da campanha (só para você)
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required placeholder="Ex.: Black Friday 2026" />
        </label>
      </section>

      <div className="cp-cols">
        <section className="card stack">
          <h2>Quem recebe</h2>
          <fieldset>
            <legend>Etapas do funil <small className="muted">(nenhuma marcada = todas)</small></legend>
            <div className="cp-chips">
              {stages.data?.map((s) => (
                <label key={s.id} className="chk"><input type="checkbox" checked={audience.stageIds.includes(s.id)} onChange={() => toggle('stageIds', s.id)} />{s.name}</label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Fontes <small className="muted">(nenhuma = todas)</small></legend>
            <div className="cp-chips">
              {SOURCES.filter(([k]) => !LEGACY_SOURCES.has(k) && k !== 'outro').map(([k, l]) => (
                <label key={k} className="chk"><input type="checkbox" checked={audience.sources.includes(k)} onChange={() => toggle('sources', k)} />{l}</label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Situação do lead</legend>
            <div className="cp-chips">
              {[['open', 'Em aberto'], ['won', 'Ganhos (clientes)'], ['lost', 'Perdidos']].map(([k, l]) => (
                <label key={k} className="chk"><input type="checkbox" checked={audience.statuses.includes(k)} onChange={() => toggle('statuses', k)} />{l}</label>
              ))}
              <label className="chk"><input type="checkbox" checked={audience.mqlOnly} onChange={(e) => setAudience({ ...audience, mqlOnly: e.target.checked })} />Só MQL</label>
            </div>
          </fieldset>
          <AudienceSummary preview={preview} channel={channel} />
        </section>

        <section className="card stack">
          <h2>Mensagem</h2>
          {channel === 'email' && <EmailFields content={content} setContent={setContent} />}
          {channel === 'sms' && <SmsFields content={content} setContent={setContent} />}
          {channel === 'whatsapp' && <WhatsAppFields content={content} setContent={setContent} />}
        </section>
      </div>

      <section className="card stack">
        <h2>Quando enviar</h2>
        <div className="row">
          <label className="chk"><input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} />Agora</label>
          <label className="chk"><input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} />Agendar</label>
          {when === 'later' && (
            <input type="datetime-local" aria-label="Data e hora do envio" value={scheduledAt} min={toLocalInput(new Date().toISOString())}
              onChange={(e) => setScheduledAt(e.target.value)} style={{ width: 'auto' }} />
          )}
        </div>
      </section>

      {err && <p className="error" role="alert">{err}</p>}
      <div className="row cp-actions">
        <button type="submit" className="secondary" disabled={save.busy || send.busy}>Salvar rascunho</button>
        <button type="button" disabled={save.busy || send.busy || !name.trim() || !preview?.reachable || !channelInfo?.configured}
          onClick={() => setConfirm(true)}>
          {when === 'later' ? 'Agendar envio' : 'Enviar agora'}
        </button>
      </div>

      {confirm && (
        <div className="modal-bg" role="dialog" aria-modal="true" aria-labelledby="cp-confirm-title">
          <div className="card modal stack">
            <h2 id="cp-confirm-title">{when === 'later' ? 'Agendar' : 'Enviar'} campanha?</h2>
            <p>
              <b>{preview?.reachable.toLocaleString('pt-BR')}</b> {preview?.reachable === 1 ? 'pessoa vai' : 'pessoas vão'} receber
              “{name}” por {CHANNEL_INFO[channel].label}
              {when === 'later' && scheduledAt ? <> em <b>{dateTimeBR(new Date(scheduledAt).toISOString())}</b></> : ' agora'}.
            </p>
            <p className="muted">Depois de enviada, a campanha não pode ser editada. Envios agendados ainda podem ser cancelados.</p>
            <div className="row">
              <button type="button" onClick={onSend} disabled={save.busy || send.busy}>{save.busy || send.busy ? 'Enviando…' : 'Confirmar'}</button>
              <button type="button" className="secondary" onClick={() => setConfirm(false)}>Voltar</button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

function AudienceSummary({ preview, channel }: { preview: Preview | null; channel: Channel }) {
  if (!preview) return <p className="muted">Calculando público…</p>;
  const miss = channel === 'email' ? 'sem e-mail válido' : channel === 'sms' ? 'sem celular válido' : 'sem telefone válido';
  return (
    <div className="cp-audience" aria-live="polite">
      <div><b className="cp-big">{preview.reachable.toLocaleString('pt-BR')}</b> vão receber</div>
      <ul className="muted">
        <li>{preview.matched.toLocaleString('pt-BR')} leads nos filtros</li>
        {!!preview.missingAddress && <li>{preview.missingAddress} {miss}</li>}
        {!!preview.optedOut && <li>{preview.optedOut} pediram para não receber</li>}
        {!!preview.duplicates && <li>{preview.duplicates} com endereço repetido (recebem uma vez)</li>}
      </ul>
      {!!preview.sample.length && (
        <small className="muted">Ex.: {preview.sample.slice(0, 3).map((s) => s.name).join(', ')}{preview.reachable > 3 ? '…' : ''}</small>
      )}
    </div>
  );
}

type FieldsProps = { content: Record<string, any>; setContent: (c: Record<string, any>) => void };

function VariableBar({ onPick }: { onPick: (v: string) => void }) {
  return (
    <div className="cp-vars">
      <small className="muted">Inserir:</small>
      {VARIABLES.map(([v, l]) => <button key={v} type="button" className="secondary" onClick={() => onPick(v)}>{l}</button>)}
    </div>
  );
}

function EmailFields({ content, setContent }: FieldsProps) {
  return (
    <>
      <label>Assunto
        <input value={content.subject} maxLength={200} onChange={(e) => setContent({ ...content, subject: e.target.value })} placeholder="Ex.: Uma oferta especial para {{empresa}}" />
      </label>
      <label>Texto do e-mail
        <textarea rows={10} value={content.body} maxLength={20000} onChange={(e) => setContent({ ...content, body: e.target.value })} />
      </label>
      <VariableBar onPick={(v) => setContent({ ...content, body: `${content.body}${v}` })} />
      <small className="muted">Linhas em branco separam parágrafos. O rodapé com o nome da sua empresa e o link de descadastro é incluído automaticamente.</small>
    </>
  );
}

function SmsFields({ content, setContent }: FieldsProps) {
  const [seg, setSeg] = useState<{ length: number; segments: number; encoding: string } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api('/campaigns/sms-segments', { method: 'POST', body: { text: content.text } }).then(setSeg).catch(() => setSeg(null));
    }, 250);
    return () => clearTimeout(t);
  }, [content.text]);
  return (
    <>
      <label>Texto do SMS
        <textarea rows={5} value={content.text} maxLength={480} onChange={(e) => setContent({ ...content, text: e.target.value })} placeholder="Ex.: {{primeiro_nome}}, sua condição especial vale até sexta!" />
      </label>
      <VariableBar onPick={(v) => setContent({ ...content, text: `${content.text}${v}` })} />
      {seg && (
        <small className={seg.segments > 1 ? 'cp-warn' : 'muted'}>
          {seg.length}/480 caracteres · {seg.segments} SMS por pessoa{seg.encoding === 'UCS-2' ? ' (acentos reduzem o limite para 70 por SMS)' : ''} · os nomes variam o tamanho
        </small>
      )}
    </>
  );
}

function WhatsAppFields({ content, setContent }: FieldsProps) {
  const params = content.params as string[];
  const setParam = (i: number, v: string) => setContent({ ...content, params: params.map((p, j) => (j === i ? v : p)) });
  return (
    <>
      <p className="muted cp-help">
        O WhatsApp só permite iniciar conversa com <b>templates aprovados pela Meta</b>. Crie o template no WhatsApp Manager
        e informe aqui o nome exato. As variáveis {'{{1}}, {{2}}'}… do template são preenchidas abaixo, na ordem.
      </p>
      <div className="form-grid">
        <label>Nome do template
          <input value={content.template} onChange={(e) => setContent({ ...content, template: e.target.value.toLowerCase() })} placeholder="ex.: promo_novembro" pattern="[a-z0-9_]+" title="Letras minúsculas, números e _" />
        </label>
        <label>Idioma
          <select value={content.language} onChange={(e) => setContent({ ...content, language: e.target.value })}>
            <option value="pt_BR">Português (BR)</option><option value="en_US">Inglês (EUA)</option><option value="es">Espanhol</option>
          </select>
        </label>
      </div>
      {params.map((p, i) => (
        <div key={i} className="row cp-param">
          <label style={{ flex: 1 }}>{`Variável {{${i + 1}}}`}
            <select value={VARIABLES.some(([v]) => v === p) ? p : '__texto'} onChange={(e) => setParam(i, e.target.value === '__texto' ? '' : e.target.value)}>
              {VARIABLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              <option value="__texto">Texto fixo…</option>
            </select>
          </label>
          {!VARIABLES.some(([v]) => v === p) && (
            <label style={{ flex: 1 }}>Texto
              <input value={p} maxLength={1024} onChange={(e) => setParam(i, e.target.value)} placeholder="Ex.: 20% de desconto" />
            </label>
          )}
          <button type="button" className="secondary" aria-label={`Remover variável ${i + 1}`} onClick={() => setContent({ ...content, params: params.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      {params.length < 10 && (
        <button type="button" className="secondary" style={{ justifySelf: 'start' }} onClick={() => setContent({ ...content, params: [...params, '{{primeiro_nome}}'] })}>
          + Variável do template
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Resultado da campanha
// ---------------------------------------------------------------------------
export function CampaignView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error, reload } = useApi<Campaign>(`/campaigns/${id}`);
  const live = data && (data.status === 'sending' || (data.status === 'scheduled' && (!data.scheduled_at || new Date(data.scheduled_at) <= new Date())));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [live, reload]);

  const cancel = useSubmit(async () => {
    await api(`/campaigns/${id}/cancel`, { method: 'POST' });
    await reload();
  });
  const remove = useSubmit(async () => {
    await api(`/campaigns/${id}`, { method: 'DELETE' });
    nav('/app/marketing/campanhas');
  });

  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="muted">Carregando…</p>;
  const s = data.stats;
  const done = s.sent + s.failed + s.skipped;
  const pct = s.total ? Math.round((done / s.total) * 100) : 0;

  return (
    <div className="cp">
      <div className="row between">
        <div>
          <h1>{data.name}</h1>
          <p className="muted cp-sub">{CHANNEL_INFO[data.channel].label} · <StatusBadge status={data.status} />
            {data.status === 'scheduled' && data.scheduled_at && <> · envio em {dateTimeBR(data.scheduled_at)}</>}
            {data.finished_at && <> · concluída em {dateTimeBR(data.finished_at)}</>}
          </p>
        </div>
        <div className="row">
          {data.status === 'draft' && <>
            <Link className="btn" to={`/app/marketing/campanhas/${id}/editar`}>Editar e enviar</Link>
            <button className="secondary" disabled={remove.busy} onClick={() => confirm('Excluir este rascunho?') && remove.run()}>Excluir</button>
          </>}
          {(data.status === 'scheduled' || data.status === 'sending') && (
            <button className="danger" disabled={cancel.busy} onClick={() => confirm('Cancelar a campanha? Quem ainda não recebeu não vai receber.') && cancel.run()}>Cancelar envio</button>
          )}
          <Link to="/app/marketing/campanhas">Voltar</Link>
        </div>
      </div>
      {(cancel.error || remove.error) && <p className="error">{cancel.error ?? remove.error}</p>}

      {data.status !== 'draft' && (
        <>
          <div className="cp-stats">
            <Stat label="Destinatários" value={s.total} />
            <Stat label="Enviadas" value={s.sent} tone="good" />
            <Stat label="Na fila" value={s.pending + s.sending} />
            <Stat label="Falhas" value={s.failed} tone={s.failed ? 'bad' : undefined} />
            {!!s.skipped && <Stat label="Não enviadas" value={s.skipped} />}
          </div>
          <div className="progress cp-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso do envio">
            <span style={{ width: `${pct}%` }} />
          </div>
          {live && <p className="muted">Atualizando automaticamente…</p>}
        </>
      )}

      <div className="cp-cols">
        <section className="card">
          <h2>Mensagem</h2>
          <ContentPreview channel={data.channel} content={data.content} />
        </section>
        {data.status !== 'draft' && (
          <section className="card cp-recipients">
            <h2>Destinatários {s.total > data.recipients.length && <small className="muted">(mostrando {data.recipients.length} de {s.total}; falhas primeiro)</small>}</h2>
            <table>
              <thead><tr><th>Lead</th><th>Endereço</th><th>Situação</th></tr></thead>
              <tbody>
                {data.recipients.map((r) => (
                  <tr key={r.id}>
                    <td>{r.lead_name ? <Link to={`/app/leads/${r.lead_id}`}>{r.lead_name}</Link> : <span className="muted">(lead excluído)</span>}</td>
                    <td>{data.channel === 'email' ? r.address : formatPhone(r.address)}</td>
                    <td>
                      <span className={`badge cr-${r.status}`}>{RECIPIENT_LABEL[r.status] ?? r.status}</span>
                      {r.error && <small className="cp-err">{r.error}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  return (
    <div className={`card cp-stat ${tone ?? ''}`}>
      <div className="k">{label}</div>
      <div className="v">{value.toLocaleString('pt-BR')}</div>
    </div>
  );
}

const formatPhone = (p: string) => {
  const m = p.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
};

function ContentPreview({ channel, content }: { channel: Channel; content: Record<string, any> }) {
  if (channel === 'email') {
    return (
      <div className="stack">
        <div><small className="muted">Assunto</small><div><b>{content.subject}</b></div></div>
        <div className="cp-body">{content.body}</div>
      </div>
    );
  }
  if (channel === 'sms') return <div className="cp-body cp-bubble">{content.text}</div>;
  return (
    <div className="stack">
      <div>Template <code>{content.template}</code> <small className="muted">({content.language})</small></div>
      {!!content.params?.length && (
        <ol className="muted">{(content.params as string[]).map((p, i) => <li key={i}>{VARIABLES.find(([v]) => v === p)?.[1] ?? p}</li>)}</ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página pública de descadastro (link no rodapé do e-mail)
// ---------------------------------------------------------------------------
export function Unsubscribe() {
  const [qs] = useSearchParams();
  const token = qs.get('token') ?? '';
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const valid = useMemo(() => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), [token]);

  // Só descadastra com clique: leitores de e-mail que "abrem" links não descadastram ninguém por engano.
  const go = async () => {
    setState('busy');
    try {
      await api('/public/unsubscribe', { method: 'POST', body: { token } });
      setState('done');
    } catch {
      setState('error');
    }
  };

  return (
    <div className="auth card stack" style={{ textAlign: 'center' }}>
      {state === 'done' ? (
        <>
          <h1>Pronto, você foi descadastrado</h1>
          <p className="muted">Você não vai mais receber estas mensagens por e-mail.</p>
        </>
      ) : !valid || state === 'error' ? (
        <>
          <h1>Link inválido</h1>
          <p className="muted">Este link de descadastro não é válido ou está incompleto. Use o link mais recente que você recebeu por e-mail.</p>
        </>
      ) : (
        <>
          <h1>Não quer mais receber nossos e-mails?</h1>
          <p className="muted">Clique abaixo para parar de receber as campanhas por e-mail desta empresa.</p>
          <button onClick={go} disabled={state === 'busy'}>{state === 'busy' ? 'Aguarde…' : 'Confirmar descadastro'}</button>
        </>
      )}
    </div>
  );
}
