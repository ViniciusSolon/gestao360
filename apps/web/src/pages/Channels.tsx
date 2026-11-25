import { useState, type FormEvent } from 'react';
import { api, can, dateTimeBR, useApi, useSubmit } from '../lib/api';
import { useSession } from '../lib/session';
import { CHANNEL_INFO, type Channel, type ChannelInfo } from './Campaigns';

/**
 * Canais: cada empresa conecta as PRÓPRIAS contas (Resend, WhatsApp da Meta, Zenvia).
 * O token é enviado uma vez, fica cifrado no servidor e nunca volta para a tela.
 */
export function Channels() {
  const { me } = useSession();
  const { data, error, reload } = useApi<ChannelInfo[]>('/channels');
  const isAdmin = can(me.user.role, 'admin');
  return (
    <div className="cp">
      <h1>Canais</h1>
      <p className="muted">
        Conecte as contas da sua empresa para enviar campanhas. As mensagens saem em nome da sua empresa e o custo de
        cada envio é cobrado direto pelo provedor. Os tokens ficam guardados cifrados e não aparecem mais depois de salvos.
      </p>
      {error && <p className="error">{error.message}</p>}
      {data?.[0] && !data[0].serverReady && (
        <div className="banner">O servidor ainda não está pronto para guardar credenciais (falta a chave de cifragem). Fale com o suporte.</div>
      )}
      {data?.[0]?.mode === 'fake' && <div className="banner">Modo de teste: os envios são simulados e não saem de verdade.</div>}
      {!isAdmin && <p className="muted">Só administradores conectam ou alteram canais.</p>}
      <div className="cp-channels">
        {data?.map((c) => <ChannelCard key={c.channel} info={c} editable={isAdmin && c.serverReady} onChanged={reload} />)}
      </div>
    </div>
  );
}

const FIELDS: Record<Channel, { key: string; label: string; placeholder?: string; help?: string }[]> = {
  email: [
    { key: 'fromName', label: 'Nome do remetente', placeholder: 'Ex.: Usaplast' },
    { key: 'fromEmail', label: 'E-mail do remetente', placeholder: 'contato@suaempresa.com.br', help: 'O domínio precisa estar verificado no Resend.' },
  ],
  whatsapp: [
    { key: 'phoneNumberId', label: 'Phone number ID', placeholder: 'Ex.: 109876543210', help: 'No painel da Meta: WhatsApp → Configuração da API.' },
  ],
  sms: [
    { key: 'from', label: 'Remetente (conta Zenvia)', placeholder: 'Ex.: nome-da-conta', help: 'Identificador de remetente cadastrado na Zenvia.' },
  ],
};
const SECRET: Record<Channel, { key: string; label: string; help: string }> = {
  email: { key: 'apiKey', label: 'API key do Resend', help: 'resend.com → API Keys → Create (permissão “Sending access”).' },
  whatsapp: { key: 'accessToken', label: 'Token de acesso permanente', help: 'Meta Business → Usuários do sistema → Gerar token (whatsapp_business_messaging).' },
  sms: { key: 'apiToken', label: 'Token da API Zenvia', help: 'app.zenvia.com → Integrações → API → Tokens.' },
};

function ChannelCard({ info, editable, onChanged }: { info: ChannelInfo; editable: boolean; onChanged: () => void }) {
  const ch = info.channel;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState('');
  const [testTo, setTestTo] = useState('');
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const startEdit = () => {
    setForm({ ...(ch === 'whatsapp' ? { defaultLanguage: 'pt_BR' } : {}), ...info.settings });
    setSecret('');
    setEditing(true);
  };
  const save = useSubmit(async () => {
    await api(`/channels/${ch}`, { method: 'PUT', body: { ...form, ...(secret.trim() ? { [SECRET[ch].key]: secret.trim() } : {}) } });
    setEditing(false);
    setSecret('');
    onChanged();
  });
  const disconnect = useSubmit(async () => {
    await api(`/channels/${ch}`, { method: 'DELETE' });
    onChanged();
  });
  const test = useSubmit(async () => {
    setTestMsg(null);
    await api(`/channels/${ch}/test`, { method: 'POST', body: { to: testTo } });
    setTestMsg(ch === 'whatsapp' ? 'Enviado! (template “hello_world” da Meta)' : 'Enviado! Confira se chegou.');
  });

  return (
    <section className="card cp-channel" aria-labelledby={`ch-${ch}`}>
      <div className="row between">
        <div className="row">
          <div className={`cp-icon cp-icon-${ch}`} aria-hidden>{CHANNEL_INFO[ch].icon}</div>
          <div>
            <h2 id={`ch-${ch}`}>{CHANNEL_INFO[ch].label}</h2>
            <small className="muted">via {CHANNEL_INFO[ch].provider}</small>
          </div>
        </div>
        {info.configured ? <span className="badge active">Conectado</span> : <span className="badge">Não conectado</span>}
      </div>

      {!editing && info.configured && (
        <dl className="cp-dl">
          {FIELDS[ch].map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{info.settings[f.key]}</dd></div>)}
          <div><dt>{SECRET[ch].label}</dt><dd><code>{info.secretHint}</code></dd></div>
          {info.updatedAt && <div><dt>Atualizado</dt><dd>{dateTimeBR(info.updatedAt)}</dd></div>}
        </dl>
      )}

      {editing ? (
        <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save.run(); }}>
          {FIELDS[ch].map((f) => (
            <label key={f.key}>{f.label}
              <input value={form[f.key] ?? ''} placeholder={f.placeholder} required onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              {f.help && <small className="muted">{f.help}</small>}
            </label>
          ))}
          <label>{SECRET[ch].label}
            <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} required={!info.configured}
              placeholder={info.configured ? 'Deixe em branco para manter o atual' : ''} />
            <small className="muted">{SECRET[ch].help}</small>
          </label>
          {save.error && <p className="error">{save.error}</p>}
          <div className="row">
            <button disabled={save.busy}>{save.busy ? 'Salvando…' : 'Salvar'}</button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>Cancelar</button>
          </div>
        </form>
      ) : editable && (
        <div className="row">
          <button className={info.configured ? 'secondary' : ''} onClick={startEdit}>{info.configured ? 'Alterar' : 'Conectar'}</button>
          {info.configured && (
            <button className="secondary" disabled={disconnect.busy}
              onClick={() => confirm(`Desconectar ${CHANNEL_INFO[ch].label}? Campanhas deste canal não poderão ser enviadas.`) && disconnect.run()}>
              Desconectar
            </button>
          )}
        </div>
      )}
      {disconnect.error && <p className="error">{disconnect.error}</p>}

      {!editing && editable && info.configured && (
        <form className="cp-test" onSubmit={(e: FormEvent) => { e.preventDefault(); test.run(); }}>
          <label>Enviar teste para
            <input value={testTo} onChange={(e) => setTestTo(e.target.value)} required
              placeholder={ch === 'email' ? 'voce@empresa.com.br' : '(11) 98888-7777'} inputMode={ch === 'email' ? 'email' : 'tel'} />
          </label>
          <button className="secondary" disabled={test.busy}>{test.busy ? 'Enviando…' : 'Testar'}</button>
          {test.error && <p className="error">{test.error}</p>}
          {testMsg && <p className="cp-ok">{testMsg}</p>}
        </form>
      )}
    </section>
  );
}
