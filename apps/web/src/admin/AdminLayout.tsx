import { useState, type FormEvent } from 'react';
import { Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { ThemeToggle } from '../lib/theme';
import { api, useApi, useSubmit } from '../lib/api';

export interface PlatformMe { adminId: string; email: string; name: string; role: 'superadmin' | 'support' }

/**
 * Painel interno da plataforma. Autenticação e cookie próprios (path /api/platform).
 * Em produção: servir em domínio separado (ex.: admin.seudominio) atrás de VPN/SSO.
 */
export function AdminLayout() {
  const me = useApi<PlatformMe>('/platform/me');
  const nav = useNavigate();
  if (me.loading && !me.data) return <div className="center muted">Carregando…</div>;
  if (!me.data) return <Navigate to="/admin/login" replace />;
  return (
    <div className="shell admin">
      <nav className="side">
        <div className="brand">Gestão 360° · Plataforma</div>
        <div className="tenant">{me.data.name} ({me.data.role})</div>
        <NavLink to="/admin" end>Clientes</NavLink>
        <NavLink to="/admin/auditoria">Auditoria</NavLink>
        <div className="spacer" />
        <ThemeToggle />
        <button className="secondary" onClick={async () => { await api('/platform/auth/logout', { method: 'POST' }).catch(() => {}); nav('/admin/login'); }}>Sair</button>
      </nav>
      <main className="main"><Outlet context={me.data} /></main>
    </div>
  );
}

/** Login em duas etapas: senha → código do app autenticador (ou código de recuperação). */
export function AdminLogin() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  const step1 = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    const r = await api<{ challenge: string }>('/platform/auth/login', { method: 'POST', body: { email, password } });
    setPassword('');
    setChallenge(r.challenge);
  });
  const step2 = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    const body = useRecovery ? { challenge, recoveryCode: code } : { challenge, code: code.replace(/\s/g, '') };
    await api('/platform/auth/mfa', { method: 'POST', body });
    nav('/admin');
  });

  return (
    <div className="auth card admin">
      <h1>Painel da plataforma</h1>
      <p className="muted">Acesso restrito à equipe interna.</p>
      {!challenge ? (
        <form className="stack" onSubmit={step1.run}>
          <label>E-mail<input required type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Senha<input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {step1.error && <div className="error">{step1.error}</div>}
          <button disabled={step1.busy}>Continuar</button>
        </form>
      ) : (
        <form className="stack" onSubmit={step2.run}>
          <label>
            {useRecovery ? 'Código de recuperação' : 'Código de 6 dígitos do app autenticador'}
            <input
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode={useRecovery ? 'text' : 'numeric'}
              pattern={useRecovery ? undefined : '[0-9 ]{6,7}'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          {step2.error && <div className="error">{step2.error}</div>}
          <button disabled={step2.busy}>Entrar</button>
          <button type="button" className="secondary" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>
            {useRecovery ? 'Usar o app autenticador' : 'Usar código de recuperação'}
          </button>
          <button type="button" className="secondary" onClick={() => { setChallenge(null); setCode(''); }}>Voltar</button>
        </form>
      )}
    </div>
  );
}
