import type { QuotaRequestRow } from '../../types';

export const exampleQuotaRequests: QuotaRequestRow[] = [
  {
    id: 'qr-eksempeldirektoratet',
    tenant: '974222333',
    tenantName: 'Eksempeldirektoratet',
    monthlyTokens: 80_000_000,
    reason: 'Saksbehandlingsassistenten går i drift for alle avdelinger i desember',
    requestedBy: 'employee:ansattporten:bjorn',
    requestedByName: 'Bjørn Aas',
    requestedAt: '2026-11-24T08:30:00Z',
    state: 'pending',
    quota: { usedTokens: 38_600_000, monthlyTokens: 40_000_000 },
  },
  {
    id: 'qr-testetaten',
    tenant: '999888777',
    tenantName: 'Testetaten',
    monthlyTokens: 60_000_000,
    reason: 'Flere tjenester i drift fra desember',
    requestedBy: 'employee:ansattporten:kari',
    requestedByName: 'Kari Nordmann',
    requestedAt: '2026-11-20T09:00:00Z',
    state: 'approved',
    decision: {
      by: 'operator:entra:drift',
      byName: 'Ola Drift',
      at: '2026-11-25T07:00:00Z',
      reason: 'Godkjent etter samtale med Kari',
    },
    quota: { usedTokens: 9_400_000, monthlyTokens: 60_000_000 },
  },
];

export const quotaRequestsMock = (
  json: (body: unknown, status?: number) => Response,
  record: (action: string, target: string, reason: string) => void,
) => {
  let rows = structuredClone(exampleQuotaRequests);
  return (
    path: string,
    method: string,
    search: URLSearchParams,
    reason: string | null,
    body: () => Record<string, unknown>,
  ): Response | undefined => {
    if (path === '/operator/quota-requests' && method === 'GET') {
      const state = search.get('state');
      return json({ data: rows.filter((r) => !state || r.state === state) });
    }
    const match = /^\/operator\/quota-requests\/([^/]+)\/([^/]+)\/decision$/.exec(path);
    if (!match || method !== 'POST') return undefined;
    const found = rows.find(
      (r) =>
        r.tenant === decodeURIComponent(match[1] ?? '') &&
        r.id === decodeURIComponent(match[2] ?? ''),
    );
    if (!found) return json({ title: 'Fant ikke', status: 404 }, 404);
    if (!reason) return json({ title: 'Mangler begrunnelse', status: 400 }, 400);
    if (found.state !== 'pending') return json({ title: 'Allerede avgjort', status: 409 }, 409);
    const decision = body().decision === 'approved' ? 'approved' : 'rejected';
    const decided: QuotaRequestRow = {
      ...found,
      state: decision,
      decision: {
        by: 'operator:entra:drift',
        byName: 'Lise Dahl',
        at: new Date().toISOString(),
        reason,
      },
      ...(decision === 'approved' && found.quota
        ? { quota: { ...found.quota, monthlyTokens: found.monthlyTokens } }
        : {}),
    };
    rows = rows.map((r) => (r === found ? decided : r));
    record('platform.quota.decide', `quota-request:${found.tenant}/${found.id}`, reason);
    return json(decided);
  };
};
