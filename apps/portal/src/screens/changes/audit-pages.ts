import { useState } from 'react';
import type { ApiClient, AuditRow } from '../../api';
import { useAsync } from '../../hooks';

interface More {
  key: string;
  rows: AuditRow[];
  status: 'idle' | 'loading' | 'error';
}

export const mergePages = (first: readonly AuditRow[], more: readonly AuditRow[]) => {
  const seen = new Set(first.map((r) => r.task));
  return [...first, ...more.filter((r) => !seen.has(r.task))];
};

export const useAuditPages = (
  api: Pick<ApiClient, 'auditPage'>,
  tenant: string,
  pageSize: number,
  enabled: boolean,
) => {
  const [first, retry] = useAsync(
    (signal) =>
      enabled
        ? api.auditPage(tenant, { limit: pageSize, offset: 0 }, signal)
        : Promise.resolve({ data: [] as AuditRow[], total: 0 }),
    [api, tenant, pageSize, enabled],
  );
  const key = `${tenant}\u0000${first.status === 'ready' ? first.data.total : ''}`;
  const [stored, setMore] = useState<More>({ key, rows: [], status: 'idle' });
  const more: More = stored.key === key ? stored : { key, rows: [], status: 'idle' };
  const rows = first.status === 'ready' ? mergePages(first.data.data, more.rows) : [];
  const total = first.status === 'ready' ? first.data.total : 0;
  const loadMore = async () => {
    if (more.status === 'loading' || first.status !== 'ready') return;
    setMore({ ...more, status: 'loading' });
    try {
      const page = await api.auditPage(tenant, {
        limit: pageSize,
        offset: first.data.data.length + more.rows.length,
      });
      setMore({ key, rows: [...more.rows, ...page.data], status: 'idle' });
    } catch {
      setMore({ ...more, status: 'error' });
    }
  };
  return { first, retry, rows, total, more: more.status, loadMore };
};
