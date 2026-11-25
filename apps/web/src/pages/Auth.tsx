import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, useSubmit } from '../lib/api';

/**
 * Login. Não há cadastro público: as empresas são cadastradas pela equipe da
 * plataforma, e cada pessoa recebe um link para definir a própria senha.
 */
export function AuthPage(_props: { mode: 'login' }) {
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: '' });
  const submit = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    await api('/auth/login', { method: 'POST', body: f });
    nav('/app');
  });

  return (
    <div className="auth card">
      <h1>Entrar</h1>
      <form className="stack" onSubmit={submit.run}>
        <label>E-mail<input required type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label>Senha<input required type="password" autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        {submit.error && <div className="error">{submit.error}</div>}
        <button disabled={submit.busy}>{submit.busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
      <p className="muted" style={{ fontSize: '.85rem' }}>
        Ainda não tem acesso? Peça ao responsável pela sua empresa, ou fale com a nossa equipe.
      </p>
    </div>
  );
}
