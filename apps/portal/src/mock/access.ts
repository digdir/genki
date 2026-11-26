import type { AccessPerson, ServiceAccess } from '../api/access';
import type { MockHandler } from '../mock';

export interface AccessMockOptions {
  people?: AccessPerson[];
  limits?: ServiceAccess[];
  altinn?: 'ok' | 'stale' | 'down' | 'not-configured' | 'entra-groups';
  servicesFail?: boolean;
  at?: string;
}

const useOnly = [
  'Anne Lund',
  'Bjørn Dahl',
  'Camilla Strand',
  'David Moe',
  'Eva Holm',
  'Fredrik Vik',
].map((name, i) => ({ id: `p-use-${i + 1}`, name, rights: ['use-services' as const] }));

export const examplePeople = (): AccessPerson[] => [
  {
    id: 'p-kari',
    name: 'Kari Nordmann',
    rights: ['use-services', 'manage-services', 'manage-datasets', 'view-usage'],
  },
  { id: 'p-ola', name: 'Ola Nordmann', rights: ['use-services', 'manage-datasets'] },
  { id: 'p-per', name: 'Per Hansen', rights: ['manage-services'] },
  { id: 'p-ingrid', name: 'Ingrid Berg', rights: ['use-services', 'view-usage'] },
  ...useOnly,
];

export const exampleLimits = (): ServiceAccess[] => [
  {
    id: 'rapportassistenten',
    mode: 'selected',
    members: [
      { id: 'p-kari', name: 'Kari Nordmann' },
      { id: 'p-ola', name: 'Ola Nordmann' },
      { id: 'p-per', name: 'Per Hansen' },
    ],
    by: 'employee:test:kari',
    byName: 'Kari Nordmann',
    at: '2026-11-17T09:12:00Z',
    reason: 'Bare piloten bruker tjenesten i november',
  },
];

const problem = (status: number, title: string, code?: string) => ({
  type: 'about:blank',
  title,
  status,
  ...(code ? { code } : {}),
});

export const accessMock = (options: AccessMockOptions = {}): MockHandler => {
  const people = structuredClone(options.people ?? examplePeople());
  let limits = structuredClone(options.limits ?? exampleLimits());
  const at = options.at ?? '2026-11-18T08:15:00Z';
  return (req) => {
    if (/^\/tenants\/[^/]+\/access\/people$/.test(req.path)) {
      if (options.altinn === 'not-configured')
        return req.json(problem(503, 'Altinn is not connected', 'altinn_not_configured'), 503);
      if (options.altinn === 'entra-groups')
        return req.json({ people: [], at, stale: false, source: 'entra-groups' });
      if (options.altinn === 'down')
        return req.json(problem(503, 'Altinn did not answer', 'altinn_unavailable'), 503);
      return req.json({ people, at, stale: options.altinn === 'stale', source: 'test-data' });
    }
    if (/^\/tenants\/[^/]+\/access\/services$/.test(req.path)) {
      if (options.servicesFail) return req.json(problem(500, 'Internal error'), 500);
      return req.json({ services: limits.filter((l) => l.mode === 'selected') });
    }
    const one = /^\/tenants\/[^/]+\/access\/services\/([^/]+)$/.exec(req.path);
    if (!one || req.method !== 'PUT') return undefined;
    if (!req.reason || req.reason.trim().length < 10) return req.reasonMissing();
    const id = decodeURIComponent(one[1] ?? '');
    const body = req.body<{ mode?: string; members?: string[] }>();
    limits = limits.filter((l) => l.id !== id);
    if (body.mode === 'all') return req.json({ id, mode: 'all', members: [] });
    const members = (body.members ?? []).flatMap((m) => {
      const found = people.find((p) => p.id === m);
      return found ? [{ id: found.id, name: found.name }] : [];
    });
    if (members.length === 0 || members.length !== (body.members ?? []).length)
      return req.json(
        { ...problem(400, 'Invalid request'), errors: [{ path: 'members', message: '' }] },
        400,
      );
    const saved: ServiceAccess = {
      id,
      mode: 'selected',
      members,
      byName: 'Kari Nordmann',
      at: new Date().toISOString(),
      reason: req.reason,
    };
    limits = [...limits, saved];
    return req.json(saved);
  };
};
