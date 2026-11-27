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

/** Nome em português dos campos, para mensagens de validação legíveis. */
const FIELD_LABELS: Record<string, string> = {
  cnpj: 'CNPJ', email: 'E-mail', name: 'Nome', company: 'Empresa', phone: 'Telefone', password: 'Senha',
  slug: 'Identificador', companyName: 'Empresa', valueCents: 'Valor', priceCents: 'Preço', sku: 'SKU', ncm: 'NCM',
  photoUrl: 'Foto', meetingUrl: 'Link da reunião', title: 'Título', freightCents: 'Frete', quantity: 'Quantidade',
};

/** "cnpj" + "CNPJ inválido" → "CNPJ inválido"; "email" + "Invalid email" → "E-mail: Invalid email". */
function describeIssue(i: { path: string; message: string }): string {
  const field = i.path.split('.').pop() ?? '';
  const label = FIELD_LABELS[field] ?? i.path;
  if (!label || i.message.toLowerCase().includes(label.toLowerCase())) return i.message;
  return `${label}: ${i.message}`;
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
        setError(err.issues?.length ? err.issues.map(describeIssue).join('; ') : err.message);
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

/**
 * Máscara de CNPJ enquanto digita (numérico ou alfanumérico): 12.ABC.345/01DE-35.
 * Só formata — quem valida os dígitos verificadores é o servidor.
 */
export function maskCnpj(v: string): string {
  const c = v.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 14);
  const parts = [c.slice(0, 2), c.slice(2, 5), c.slice(5, 8), c.slice(8, 12), c.slice(12, 14)];
  let out = parts[0];
  if (parts[1]) out += `.${parts[1]}`;
  if (parts[2]) out += `.${parts[2]}`;
  if (parts[3]) out += `/${parts[3]}`;
  if (parts[4]) out += `-${parts[4]}`;
  return out;
}

export const formatCnpj = (v: string | null | undefined) => (v ? maskCnpj(v) : '');

export type Role ='owner' | 'admin' | 'manager' | 'seller';
const RANK: Record<Role, number> = { seller: 1, manager: 2, admin: 3, owner: 4 };
/** Só para esconder botões (UX). O servidor valida de novo. */
export const can = (role: Role | undefined, min: Role) => !!role && RANK[role] >= RANK[min];

export const ROLE_LABEL: Record<Role, string> = { owner: 'Proprietário', admin: 'Administrador', manager: 'Gerente', seller: 'Vendedor' };
/** Fontes de aquisição (mesma lista e ordem do servidor: apps/api/src/lib/sources.ts). */
export const SOURCES: [string, string][] = [
  ['google_ads', 'Google Ads'], ['meta_ads', 'Meta Business'], ['tiktok_ads', 'TikTok Ads'], ['linkedin_ads', 'LinkedIn Ads'],
  ['google_organico', 'Google Orgânico'], ['whatsapp', 'WhatsApp'], ['instagram_organico', 'Instagram Orgânico'],
  ['indicacao', 'Indicação'], ['direto', 'Direto'], ['chatgpt_ads', 'ChatGPT Ads'],
  // legado (leads antigos)
  ['site', 'Site'], ['evento', 'Evento'], ['email', 'E-mail'], ['telefone', 'Telefone'], ['redes_sociais', 'Redes sociais'], ['outro', 'Outro'],
];
export const LEGACY_SOURCES = new Set(['site', 'evento', 'email', 'telefone', 'redes_sociais']);
export const CHANNELS: Record<string, string> = Object.fromEntries(SOURCES);

/** Situação da proposta e temperatura (rótulos em português). */
export const PROPOSAL_STATUS: Record<string, string> = { draft: 'Rascunho', sent: 'Enviada', accepted: 'Aceita', rejected: 'Recusada' };
export const TEMPERATURE: Record<string, string> = { hot: 'Quente', warm: 'Morno', cold: 'Frio' };
export const TEMPERATURE_ICON: Record<string, string> = { hot: '🔥', warm: '🌤', cold: '❄' };
