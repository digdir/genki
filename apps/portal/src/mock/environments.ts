import type { EnvironmentView, ServiceEnvironments } from '../api/environments';
import type { MockHandler } from '../mock';

interface Pointer {
  version?: number;
  previousVersion?: number;
}

export interface EnvironmentsMockOptions {
  latest?: (service: string) => number | undefined;
  initial?: Record<string, Record<string, Pointer>>;
}

const invalid = (path: string, message: string, status = 400) => ({
  body: {
    title: status === 409 ? 'Conflict' : 'Invalid request',
    status,
    errors: [{ path, message }],
  },
  status,
});

export const environmentsMock = (options: EnvironmentsMockOptions = {}): MockHandler => {
  const pointers = new Map(Object.entries(structuredClone(options.initial ?? {})));
  const of = (service: string) => pointers.get(service) ?? { prod: {} };
  const view = (service: string, latest: number): ServiceEnvironments => ({
    latestVersion: latest,
    environments: Object.entries(of(service))
      .sort(([a], [b]) => (a === 'prod' ? -1 : b === 'prod' ? 1 : a.localeCompare(b)))
      .map(([name, p]): EnvironmentView => ({
        name,
        version: p.version ?? latest,
        followsPublishes: p.version === undefined,
        previousVersion: p.previousVersion ?? null,
      })),
  });

  return ({ path, method, body, reason, json, notFound, reasonMissing }) => {
    const match =
      /^\/tenants\/[^/]+\/services\/([^/]+)\/environments(?:\/([^/]+)(?:\/(promote|rollback))?)?$/.exec(
        path,
      );
    if (!match) return undefined;
    const service = decodeURIComponent(match[1] ?? '');
    const name = match[2] ? decodeURIComponent(match[2]) : undefined;
    const latest = options.latest?.(service);
    if (latest === undefined) return notFound();
    if (method === 'GET' && !name) return json(view(service, latest));
    if (!reason) return reasonMissing();
    const before = of(service);
    const reply = (after: Record<string, Pointer>, status = 200) => {
      pointers.set(service, after);
      return json(view(service, latest), status);
    };
    const refuse = (r: ReturnType<typeof invalid>) => json(r.body, r.status);
    if (method === 'POST' && !name) {
      const wanted = body<{ name?: string }>().name ?? '';
      if (wanted in before) return refuse(invalid('state', `${wanted} exists`, 409));
      const prod = before.prod ?? {};
      return reply(
        { ...before, prod: prod.version === undefined ? { version: latest } : prod, [wanted]: {} },
        201,
      );
    }
    if (!name || !(name in before)) return notFound();
    if (method === 'DELETE') {
      const after = Object.fromEntries(Object.entries(before).filter(([k]) => k !== name));
      return reply(Object.keys(after).length > 1 ? after : { prod: {} });
    }
    if (Object.keys(before).length === 1)
      return refuse(invalid('state', 'prod is the only environment', 409));
    const current = before[name]?.version ?? latest;
    if (match[3] === 'promote') {
      const from = body<{ from?: string }>().from ?? 'test';
      const source = before[from];
      if (!source) return notFound();
      return reply({
        ...before,
        [name]: { version: source.version ?? latest, previousVersion: current },
      });
    }
    const version = body<{ version?: number }>().version ?? before[name]?.previousVersion;
    if (version === undefined) return refuse(invalid('version', 'no earlier version'));
    return reply({ ...before, [name]: { version, previousVersion: current } });
  };
};
