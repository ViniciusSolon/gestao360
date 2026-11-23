import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public issues?: { path: string; message: string }[]) {
    super(message);
  }
}

/**
 * Cliente HTTP. Sessão em cookie httpOnly (o JS não lê o token).
 * Nenhum segredo vive no front: preços, permissões e limites são decididos no servidor.
 */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.includes('/auth/')) {
    const loginPath = path.startsWith('/platform') ? '/admin/login' : '/login';
    if (location.pathname !== loginPath) location.assign(loginPath);
  }
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Erro ${res.status}`, data?.issues);
  return data as T;
}

/** Carrega dados com estado de loading/erro e função de recarregar. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/**
 * Envio de formulário: desabilita o botão enquanto envia (conforto de UX).
 * A proteção real contra duplicidade está no servidor/banco.
 */
export function useSubmit<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (e) {
        const err = e as ApiError;
        setError(err.issues?.length ? `${err.message}: ${err.issues.map((i) => `${i.path} ${i.message}`).join('; ')}` : err.message);
        return undefined;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [fn],
  );
  return { run, busy, error, setError };
}

/** Uma chave de idempotência por operação; renova só depois de sucesso. */
export function useIdempotencyKey() {
  const ref = useRef(crypto.randomUUID());
  return { key: () => ref.current, renew: () => (ref.current = crypto.randomUUID()) };
}

export const brl = (cents: number | string | null | undefined) =>
  (Number(cents ?? 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const dateBR = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('pt-BR') : '—');
export const dateTimeBR = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/** Converte "1.234,56" ou "1234.56" em centavos. */
export function toCents(v: string): number {
  const n = Number(v.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export type Role = 'owner' | 'admin' | 'manager' | 'seller';
const RANK: Record<Role, number> = { seller: 1, manager: 2, admin: 3, owner: 4 };
/** Só para esconder botões (UX). O servidor valida de novo. */
export const can = (role: Role | undefined, min: Role) => !!role && RANK[role] >= RANK[min];

export const ROLE_LABEL: Record<Role, string> = { owner: 'Proprietário', admin: 'Administrador', manager: 'Gerente', seller: 'Vendedor' };
export const CHANNELS: Record<string, string> = {
  site: 'Site', indicacao: 'Indicação', evento: 'Evento', whatsapp: 'WhatsApp', email: 'E-mail',
  telefone: 'Telefone', redes_sociais: 'Redes sociais', outro: 'Outro',
};
