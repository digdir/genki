import { flagKeys, flags, isFlagKey, type FlagState } from '@genai/contracts/flags';
import type { OperatorFlag } from '../../types';

type Row = OperatorFlag['rows'][number];

export const flagsMock = (
  json: (body: unknown, status?: number) => Response,
  now = () => new Date('2026-11-26T12:00:00Z'),
) => {
  let rows: (Row & { key: string; expiresAt?: string })[] = [
    {
      key: 'blockStudio',
      tenant: '983555666',
      tenantName: 'Kontrollrådet',
      on: true,
      by: 'operator:entra:lise',
      byName: 'Lise Dahl',
      at: '2026-11-12T09:00:00Z',
      reason: 'Pilot for designelementer',
      expiresAt: '2026-12-31T22:59:59Z',
    },
    {
      key: 'blockStudio',
      tenant: '983555666',
      tenantName: 'Kontrollrådet',
      person: { issuer: 'https://login.example.no', subject: 'marte' },
      personName: 'Marte Solheim',
      on: false,
      by: 'operator:entra:bjorn',
      byName: 'Bjørn Aas',
      at: '2026-11-20T10:00:00Z',
      reason: 'Vil teste uten',
    },
    {
      key: 'blockStudio',
      tenant: '983888999',
      tenantName: 'Eksempelhelseforetaket',
      on: true,
      by: 'operator:entra:lise',
      byName: 'Lise Dahl',
      at: '2026-11-12T09:05:00Z',
      reason: 'Pilot for designelementer',
      expiresAt: '2026-11-30T22:59:59Z',
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
  const handle = (
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
          rows: rows
            .filter((r) => r.key === key)
            .map(({ key: _key, ...row }) =>
              row.expiresAt
                ? { ...row, expired: Date.parse(row.expiresAt) <= now().getTime() }
                : row,
            ),
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
      expiresAt?: string;
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
          ...(change.expiresAt ? { expiresAt: change.expiresAt } : {}),
          by: 'operator:entra:drift',
          at: new Date().toISOString(),
          reason,
        },
        ...rows,
      ];
    return json({ key, on: change.on === true });
  };
  return Object.assign(handle, { rows: () => rows });
};
