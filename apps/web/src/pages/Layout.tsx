import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, can, ROLE_LABEL } from '../lib/api';
import { useSession } from '../lib/session';

export function AppLayout() {
  const { me } = useSession();
  const nav = useNavigate();
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    nav('/login');
  };
  const trialDays = Math.ceil((new Date(me.tenant.trialEndsAt).getTime() - Date.now()) / 86400000);
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">Gestão 360°</div>
        <div className="tenant">{me.tenant.name} · {me.user.name} ({ROLE_LABEL[me.user.role]})</div>
        <NavLink to="/app" end>Indicadores</NavLink>
        <NavLink to="/app/funil">Funil (Kanban)</NavLink>
        <NavLink to="/app/agenda">Agenda</NavLink>
        <NavLink to="/app/propostas">Propostas</NavLink>
        <NavLink to="/app/produtos">Produtos</NavLink>
        {can(me.user.role, 'admin') && <NavLink to="/app/equipe">Equipe</NavLink>}
        <NavLink to="/app/assinatura">Assinatura</NavLink>
        <div className="spacer" />
        <button className="secondary" onClick={logout}>Sair</button>
      </nav>
      <main className="main">
        {!me.tenant.usable && <div className="banner">{me.tenant.blockedReason} <NavLink to="/app/assinatura">Ver assinatura</NavLink></div>}
        {me.tenant.usable && me.tenant.status === 'trialing' && <div className="banner">Período de teste: {trialDays} dia(s) restante(s).</div>}
        {me.tenant.status === 'past_due' && <div className="banner">Pagamento pendente. Regularize para evitar bloqueio.</div>}
        <Outlet />
      </main>
    </div>
  );
}
