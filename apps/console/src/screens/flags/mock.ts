import { flagKeys, flags, isFlagKey, type FlagState } from '@genai/contracts/flags';
import type { OperatorFlag } from '../../types';

type Row = OperatorFlag['rows'][number];

export const flagsMock = (json: (body: unknown, status?: number) => Response) => {
  let rows: (Row & { key: string })[] = [
    {
      key: 'blockStudio',
      tenant: '991825827',
      tenantName: 'Digitaliseringsdirektoratet',
      on: true,
      by: 'operator:entra:drift',
      byName: 'Ola Drift',
      at: '2026-11-24T09:00:00Z',
      reason: 'Laben prøver Block Studio først',
    },
  ];
  const mine: FlagState[] = flagKeys.map((key) => ({
    key,
    on: false,
    source: 'default',
    selfService: flags[key].selfService,
    person: null,
    tenant: null,
  }));
  return (
    path: string,
    method: string,
    reason: string | null,
    body: () => Record<string, unknown>,
  ): Response | undefined => {
    if (path === '/me/flags' && method === 'GET') return json({ data: mine });
    if (path === '/operator/flags' && method === 'GET')
      return json({
        data: Object.entries(flags).map(([key, spec]) => ({
          key,
          ...spec,
          rows: rows.filter((r) => r.key === key).map(({ key: _key, ...row }) => row),
        })),
      });
    const match = /^\/operator\/flags\/([^/]+)$/.exec(path);
    if (!match || method !== 'PUT') return undefined;
    const key = decodeURIComponent(match[1] ?? '');
    if (!isFlagKey(key)) return json({ title: 'Fant ikke', status: 404 }, 404);
    if (!reason) return json({ title: 'Mangler begrunnelse', status: 400 }, 400);
    const change = body() as {
      tenant: string;
      person?: { issuer: string; subject: string };
      on: boolean | null;
    };
    const same = (r: Row & { key: string }) =>
      r.key === key &&
      r.tenant === change.tenant &&
      r.person?.issuer === change.person?.issuer &&
      r.person?.subject === change.person?.subject;
    rows = rows.filter((r) => !same(r));
    if (change.on !== null)
      rows = [
        {
          key,
          tenant: change.tenant,
          ...(change.person ? { person: change.person } : {}),
          on: change.on,
          by: 'operator:entra:drift',
          at: new Date().toISOString(),
          reason,
        },
        ...rows,
      ];
    return json({ key, on: change.on === true });
  };
};
