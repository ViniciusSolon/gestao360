import { createContext, useContext, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useApi, type Role } from './api';

export interface Me {
  user: { id: string; name: string; email: string; role: Role };
  tenant: { id: string; name: string; status: string; trialEndsAt: string; usable: boolean; blockedReason: string | null };
}

const Ctx = createContext<{ me: Me; reload: () => void } | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { data, loading, error, reload } = useApi<Me>('/auth/me');
  if (loading && !data) return <div className="center muted">Carregando…</div>;
  if (error || !data) return <Navigate to="/login" replace />;
  return <Ctx.Provider value={{ me: data, reload }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('fora do SessionProvider');
  return c;
}
