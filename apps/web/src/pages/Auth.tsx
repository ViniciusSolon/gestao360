import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, useSubmit } from '../lib/api';

export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const nav = useNavigate();
  const [f, setF] = useState({ companyName: '', slug: '', name: '', email: '', password: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = useSubmit(async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'login') await api('/auth/login', { method: 'POST', body: { email: f.email, password: f.password } });
    else await api('/auth/signup', { method: 'POST', body: f });
    nav('/app');
  });

  return (
    <div className="auth card">
      <h1>{mode === 'login' ? 'Entrar' : 'Criar conta da empresa'}</h1>
      <form className="stack" onSubmit={submit.run}>
        {mode === 'signup' && (
          <>
            <label>Empresa<input required value={f.companyName} onChange={set('companyName')} /></label>
            <label>
              Identificador (URL)
              <input required pattern="[a-z0-9][a-z0-9\-]{1,62}" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} placeholder="minha-empresa" />
            </label>
            <label>Seu nome<input required value={f.name} onChange={set('name')} /></label>
          </>
        )}
        <label>E-mail<input required type="email" autoComplete="email" value={f.email} onChange={set('email')} /></label>
        <label>
          Senha
          <input required type="password" minLength={mode === 'signup' ? 10 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={f.password} onChange={set('password')} />
        </label>
        {submit.error && <div className="error">{submit.error}</div>}
        <button disabled={submit.busy}>{submit.busy ? 'Enviando…' : mode === 'login' ? 'Entrar' : 'Criar conta (14 dias grátis)'}</button>
      </form>
      <p className="muted">
        {mode === 'login' ? <>Não tem conta? <Link to="/cadastro">Cadastre sua empresa</Link></> : <>Já tem conta? <Link to="/login">Entrar</Link></>}
      </p>
    </div>
  );
}
