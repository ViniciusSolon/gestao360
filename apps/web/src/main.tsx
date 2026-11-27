import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { SessionProvider } from './lib/session';
import { AuthPage } from './pages/Auth';
import { AcceptInvite } from './pages/AcceptInvite';
import { AppLayout } from './pages/Layout';
import { Kanban, KanbanIndex } from './pages/Kanban';
import { LeadDetail } from './pages/LeadDetail';
import { Activities } from './pages/Activities';
import { Products } from './pages/Products';
import { Proposals, ProposalNew, ProposalView } from './pages/Proposals';
import { Dashboard } from './pages/Dashboard';
import { IndicadoresIndex, Marketing } from './pages/Marketing';
import { UserForm, Users } from './pages/Users';
import { CampaignEditor, CampaignsHome, CampaignView, Unsubscribe } from './pages/Campaigns';
import { Channels } from './pages/Channels';
import { Billing, FakeCheckout } from './pages/Billing';
import { AdminLayout, AdminLogin } from './admin/AdminLayout';
import { AdminTenants } from './admin/AdminTenants';
import { AdminTenant } from './admin/AdminTenant';
import { AdminAudit } from './admin/AdminAudit';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/app" replace />} />
        <Route path="/login" element={<AuthPage mode="login" />} />
        {/* Não há cadastro público: links antigos vão para o login */}
        <Route path="/cadastro" element={<Navigate to="/login" replace />} />
        <Route path="/convite" element={<AcceptInvite />} />
        <Route path="/descadastro" element={<Unsubscribe />} />
        <Route path="/app" element={<SessionProvider><AppLayout /></SessionProvider>}>
          <Route index element={<IndicadoresIndex />} />
          <Route path="indicadores" element={<IndicadoresIndex />} />
          <Route path="indicadores/marketing" element={<Marketing />} />
          <Route path="indicadores/comercial" element={<Dashboard />} />
          <Route path="marketing" element={<Navigate to="/app/marketing/campanhas" replace />} />
          <Route path="marketing/campanhas" element={<CampaignsHome />} />
          <Route path="marketing/campanhas/nova" element={<CampaignEditor />} />
          <Route path="marketing/campanhas/:id" element={<CampaignView />} />
          <Route path="marketing/campanhas/:id/editar" element={<CampaignEditor />} />
          <Route path="marketing/canais" element={<Channels />} />
          <Route path="funil" element={<KanbanIndex />} />
          <Route path="funil/:pipelineId" element={<Kanban />} />
          <Route path="leads/:id" element={<LeadDetail />} />
          <Route path="agenda" element={<Activities />} />
          <Route path="produtos" element={<Products />} />
          <Route path="propostas" element={<Proposals />} />
          <Route path="propostas/nova" element={<ProposalNew />} />
          <Route path="propostas/:id" element={<ProposalView />} />
          <Route path="equipe" element={<Navigate to="/app/organizacao/usuarios" replace />} />
          <Route path="organizacao" element={<Navigate to="/app/organizacao/usuarios" replace />} />
          <Route path="organizacao/usuarios" element={<Users />} />
          <Route path="organizacao/usuarios/novo" element={<UserForm />} />
          <Route path="organizacao/usuarios/:id" element={<UserForm />} />
          <Route path="assinatura" element={<Billing />} />
          <Route path="assinatura/checkout-fake" element={<FakeCheckout />} />
        </Route>
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminTenants />} />
          <Route path="clientes/:id" element={<AdminTenant />} />
          <Route path="auditoria" element={<AdminAudit />} />
        </Route>
        <Route path="*" element={<div className="center">Página não encontrada</div>} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
