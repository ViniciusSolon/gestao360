import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, useSubmit } from '../lib/api';

export function AcceptInvite() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const submit = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    await api('/auth/accept-invite', { method: 'POST', body: { token: params.get('token') ?? '', name, password } });
    nav('/app');
  });
  return (
    <div className="auth card">
      <h1>Aceitar convite</h1>
      <form className="stack" onSubmit={submit.run}>
        <label>Seu nome<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Crie uma senha<input required type="password" minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {submit.error && <div className="error">{submit.error}</div>}
        <button disabled={submit.busy}>Entrar na equipe</button>
      </form>
    </div>
  );
}
