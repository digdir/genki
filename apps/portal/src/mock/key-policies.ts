import type { KeyPolicy, NewKeyPolicy } from '../api/key-policies';
import type { MockHandler } from '../mock';

export interface KeyPoliciesMockOptions {
  policies?: KeyPolicy[];
}

export const exampleKeyPolicies = (): KeyPolicy[] => [
  {
    id: 'pol-1',
    name: 'Bare klarspråk',
    scopes: ['query'],
    datasets: [],
    agents: ['klarsprak__default'],
    modes: [],
    allowedConfigKeys: [],
    keyIds: ['key-gammel'],
    createdAt: '2026-09-14T08:30:00Z',
  },
];

export const keyPoliciesMock = (options: KeyPoliciesMockOptions = {}): MockHandler => {
  let policies = structuredClone(options.policies ?? exampleKeyPolicies());
  return (req) => {
    const attach = /^\/tenants\/[^/]+\/api-keys\/([^/]+)\/policy$/.exec(req.path);
    if (attach) {
      if (!req.reason) return req.reasonMissing();
      const key = decodeURIComponent(attach[1] ?? '');
      const chosen = req.method === 'PUT' ? req.body<{ policyId?: string }>().policyId : undefined;
      policies = policies.map((p) => ({
        ...p,
        keyIds: [...p.keyIds.filter((k) => k !== key), ...(p.id === chosen ? [key] : [])],
      }));
      return req.json({ keyId: key, policy: chosen ?? null });
    }
    const route = /^\/tenants\/[^/]+\/api-key-policies(?:\/([^/]+))?$/.exec(req.path);
    if (!route) return undefined;
    const id = route[1] ? decodeURIComponent(route[1]) : undefined;
    if (!id && req.method === 'GET') return req.json({ data: policies });
    if (!req.reason) return req.reasonMissing();
    if (id && req.method === 'DELETE') {
      const found = policies.find((p) => p.id === id);
      if (!found) return req.notFound();
      if (found.keyIds.length)
        return req.json(
          { title: 'Konflikt', status: 409, errors: [{ path: 'id', message: '' }] },
          409,
        );
      policies = policies.filter((p) => p.id !== id);
      return req.json({ id });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const body = req.body<Partial<NewKeyPolicy>>();
      if (!body.name?.trim())
        return req.json(
          {
            title: 'Ugyldig forespørsel',
            status: 400,
            errors: [{ path: 'name', message: 'required' }],
          },
          400,
        );
      const fields = {
        name: body.name.trim(),
        scopes: body.scopes ?? [],
        datasets: body.datasets ?? [],
        agents: body.agents ?? [],
        modes: body.modes ?? [],
        allowedConfigKeys: body.allowedConfigKeys ?? [],
      };
      if (id) {
        const found = policies.find((p) => p.id === id);
        if (!found) return req.notFound();
        const next = { ...found, ...fields };
        policies = policies.map((p) => (p.id === id ? next : p));
        return req.json(next);
      }
      const created: KeyPolicy = {
        ...fields,
        id: `pol-${policies.length + 1}`,
        keyIds: [],
        createdAt: new Date().toISOString(),
      };
      policies = [...policies, created];
      return req.json(created, 201);
    }
    return undefined;
  };
};
