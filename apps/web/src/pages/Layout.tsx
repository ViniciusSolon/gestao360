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

/** Abas de Marketing (gerente para cima). */
export const marketingTabs = [
  { to: '/app/marketing/campanhas', label: 'Campanhas' },
  { to: '/app/marketing/canais', label: 'Canais' },
];

/** Grupo expansível do menu: clicar abre as abas e já leva para a primeira. */
function NavGroup({ id, label, base, tabs, alsoActive }: { id: string; label: string; base: string; tabs: { to: string; label: string }[]; alsoActive?: boolean }) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const inside = !!alsoActive || pathname.startsWith(base);
  const [open, setOpen] = useState(inside);
  useEffect(() => { if (inside) setOpen(true); }, [inside]);
  return (
    <div className={`nav-group ${open ? 'open' : ''}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (!open && !inside) nav(tabs[0].to);
          setOpen(!open || !inside);
        }}
      >
        <span>{label}</span><span className="chev" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="nav-sub" id={id}>
          {tabs.map((t) => <NavLink key={t.to} to={t.to}>{t.label}</NavLink>)}
        </div>
      )}
    </div>
  );
}

export function AppLayout() {
  const { me } = useSession();
  const nav = useNavigate();
  const { pathname } = useLocation();

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    nav('/login');
  };
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">Gestão 360°</div>
        <div className="tenant">{me.tenant.name} · {me.user.name} ({ROLE_LABEL[me.user.role]})</div>
        <NavGroup id="nav-indicadores" label="Indicadores" base="/app/indicadores" alsoActive={pathname === '/app'} tabs={indicatorTabs(me.user.role)} />
        {can(me.user.role, 'manager') && <NavGroup id="nav-marketing" label="Marketing" base="/app/marketing" tabs={marketingTabs} />}
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
