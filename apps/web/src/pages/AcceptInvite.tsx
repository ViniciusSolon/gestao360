import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, useSubmit } from '../lib/api';

interface InviteInfo { tenantName: string; name: string | null; email: string; role: string; roleLabel: string }

/**
 * Tela do link de acesso: primeira senha do responsável (enviado pela plataforma)
 * ou de quem foi convidado para a equipe.
 */
export function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    api<InviteInfo>(`/auth/invite?token=${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e: ApiError) => setLoadError(e.status === 410 || e.status === 400 ? 'Este link é inválido, expirou ou já foi usado.' : e.message));
  }, [token]);

  const submit = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) throw new Error('As senhas não conferem.');
    await api('/auth/accept-invite', { method: 'POST', body: { token, password, ...(info?.name ? {} : { name }) } });
    nav('/app');
  });

  if (loadError) {
    return (
      <div className="auth card welcome">
        <h1>Link indisponível</h1>
        <p className="muted">{loadError}</p>
        <p className="muted">Peça um novo link a quem enviou o acesso.</p>
        <Link to="/login"><button className="secondary">Ir para o login</button></Link>
      </div>
    );
  }
  if (!info) return <div className="center muted">Carregando…</div>;

  const mismatch = confirm.length > 0 && password !== confirm;
  return (
    <div className="auth card welcome">
      <div className="welcome-head">
        <h1>Bem-vindo à Gestão 360°!</h1>
        <p className="muted">Complete seu cadastro para acessar o sistema</p>
      </div>
      <div className="invite-box">
        <div className="muted invite-title">Você foi convidado para <strong>{info.tenantName}</strong>:</div>
        {info.name && <div className="invite-name">{info.name}</div>}
        <div className="muted">{info.email}</div>
        <span className="badge role">{info.roleLabel}</span>
      </div>
      <form className="stack" onSubmit={submit.run}>
        {!info.name && <label>Seu nome<input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>}
        <label>
          Criar senha
          <input required type="password" minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <span className="muted" style={{ fontSize: '.8rem' }}>Mínimo de 10 caracteres</span>
        </label>
        <label>
          Confirmar senha
          <input required type="password" minLength={10} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} />
          {mismatch && <span className="error">As senhas não conferem.</span>}
        </label>
        {submit.error && <div className="error">{submit.error}</div>}
        <button disabled={submit.busy || mismatch}>{submit.busy ? 'Criando…' : 'Aceitar convite e criar conta'}</button>
        <p className="muted" style={{ fontSize: '.8rem', textAlign: 'center', margin: 0 }}>Ao aceitar, você concorda com os termos de uso do sistema.</p>
      </form>
    </div>
  );
}
