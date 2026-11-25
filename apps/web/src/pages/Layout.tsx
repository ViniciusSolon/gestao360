import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, can, ROLE_LABEL } from '../lib/api';
import { useSession } from '../lib/session';

/** Abas de Indicadores. A primeira é Marketing (gerente para cima). */
export function indicatorTabs(role: Parameters<typeof can>[0]) {
  return [
    ...(can(role, 'manager') ? [{ to: '/app/indicadores/marketing', label: 'Marketing' }] : []),
    { to: '/app/indicadores/comercial', label: 'Comercial' },
  ];
}

export function AppLayout() {
  const { me } = useSession();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const inIndicators = pathname === '/app' || pathname.startsWith('/app/indicadores');
  const [open, setOpen] = useState(inIndicators);
  useEffect(() => { if (inIndicators) setOpen(true); }, [inIndicators]);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    nav('/login');
  };
  const tabs = indicatorTabs(me.user.role);
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">Gestão 360°</div>
        <div className="tenant">{me.tenant.name} · {me.user.name} ({ROLE_LABEL[me.user.role]})</div>
        <div className={`nav-group ${open ? 'open' : ''}`}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="nav-indicadores"
            onClick={() => {
              // Clicar abre as abas e já leva para a primeira (Marketing)
              if (!open && !inIndicators) nav(tabs[0].to);
              setOpen(!open || !inIndicators);
            }}
          >
            <span>Indicadores</span><span className="chev" aria-hidden>▾</span>
          </button>
          {open && (
            <div className="nav-sub" id="nav-indicadores">
              {tabs.map((t) => <NavLink key={t.to} to={t.to}>{t.label}</NavLink>)}
            </div>
          )}
        </div>
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
        {me.tenant.status === 'past_due' && <div className="banner">Pagamento pendente. Regularize para evitar bloqueio.</div>}
        <Outlet />
      </main>
    </div>
  );
}
