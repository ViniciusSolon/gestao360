import { useEffect, useState } from 'react';
import { api } from './api';

export interface Stage { id: string; pipeline_id: string; name: string; kind: 'open' | 'won' | 'lost'; probability: number }
export interface Pipeline { id: string; name: string; stages: Stage[] }

/**
 * Lista de funis compartilhada entre o menu e as telas: quando um funil é criado,
 * renomeado ou excluído em qualquer lugar, todos atualizam juntos.
 * O cache é por empresa: trocar de conta na mesma aba nunca mostra funis de outra.
 */
let cache: { tenantId: string; data: Pipeline[] } | null = null;
let currentTenant: string | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<(p: Pipeline[] | null) => void>();

export function reloadPipelines(): Promise<void> {
  const tenant = currentTenant;
  inflight ??= api<Pipeline[]>('/pipelines')
    .then((data) => {
      if (tenant !== currentTenant || !tenant) return;
      cache = { tenantId: tenant, data };
      listeners.forEach((fn) => fn(data));
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function usePipelines(tenantId: string) {
  if (currentTenant !== tenantId) {
    currentTenant = tenantId;
    if (cache?.tenantId !== tenantId) cache = null;
  }
  const [data, setData] = useState<Pipeline[] | null>(cache?.data ?? null);
  useEffect(() => {
    listeners.add(setData);
    if (!cache) reloadPipelines().catch(() => {});
    else setData(cache.data);
    return () => { listeners.delete(setData); };
  }, [tenantId]);
  return { data, reload: reloadPipelines };
}

/** Pede o nome, cria o funil e devolve o novo (ou null se cancelou). */
export async function createPipelineInteractive(): Promise<Pipeline | null> {
  const name = prompt('Nome do novo funil (ex.: Pré-venda, Prospecção, Carteira de clientes):')?.trim();
  if (!name) return null;
  const p = await api<Pipeline>('/pipelines', { method: 'POST', body: { name } });
  await reloadPipelines();
  return p;
}
