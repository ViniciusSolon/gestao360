import { dateTimeBR, useApi } from '../lib/api';

export function AdminAudit() {
  const { data } = useApi<any[]>('/platform/audit');
  return (
    <div>
      <h1>Auditoria</h1>
      <table>
        <thead><tr><th>Quando</th><th>Cliente</th><th>Ator</th><th>Ação</th><th>Detalhes</th><th>IP</th></tr></thead>
        <tbody>
          {(data ?? []).map((a) => (
            <tr key={a.id}>
              <td>{dateTimeBR(a.created_at)}</td><td>{a.tenant_name ?? '—'}</td><td>{a.actor_type}</td><td>{a.action}</td>
              <td><code style={{ fontSize: '.75rem' }}>{JSON.stringify(a.metadata)}</code></td><td>{a.ip ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
