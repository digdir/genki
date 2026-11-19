import type { EnvironmentView, ServiceEnvironments } from '../api/environments';
import type { EnvironmentChange } from '../api/service-tabs';
import type { MockHandler } from '../mock';

interface Pointer {
  version?: number;
  previousVersion?: number;
  description?: string;
}

export interface EnvironmentsMockOptions {
  latest?: (service: string) => number | undefined;
  initial?: Record<string, Record<string, Pointer>>;
  history?: Record<string, EnvironmentChange[]>;
  now?: () => Date;
}

const kari = { by: 'employee:mock:kari', byName: 'Kari Nordmann' };
const ola = { by: 'employee:ansattporten:ola', byName: 'Ola Hansen' };

export const exampleEnvironments: Record<string, Record<string, Pointer>> = {
  rapportassistenten: {
    prod: { version: 7, previousVersion: 6 },
    test: { description: 'testerne i HR' },
  },
};

export const exampleEnvironmentHistory: Record<string, EnvironmentChange[]> = {
  rapportassistenten: [
    {
      environment: 'prod',
      action: 'promoted',
      version: 7,
      previousVersion: 6,
      from: 'test',
      at: '2026-11-12T09:14:00Z',
      ...kari,
      reason: 'Testet i HR siden 11. nov',
    },
    {
      environment: 'prod',
      action: 'promoted',
      version: 6,
      previousVersion: 5,
      from: 'test',
      at: '2026-11-03T08:02:00Z',
      ...ola,
      reason: '',
    },
    {
      environment: 'test',
      action: 'added',
      version: null,
      previousVersion: null,
      at: '2026-10-28T12:30:00Z',
      ...ola,
      reason: 'Testerne i HR prøver nye versjoner først',
    },
  ],
};

const invalid = (path: string, message: string, status = 400) => ({
  body: {
    title: status === 409 ? 'Conflict' : 'Invalid request',
    status,
    errors: [{ path, message }],
  },
  status,
});

export const environmentsMock = (options: EnvironmentsMockOptions = {}): MockHandler => {
  const example = import.meta.env.MODE !== 'test';
  const pointers = new Map(
    Object.entries(structuredClone(options.initial ?? (example ? exampleEnvironments : {}))),
  );
  const changes = new Map(
    Object.entries(structuredClone(options.history ?? (example ? exampleEnvironmentHistory : {}))),
  );
  const now = options.now ?? (() => new Date());
  const record = (service: string, change: Omit<EnvironmentChange, 'at' | 'by' | 'byName'>) =>
    changes.set(service, [
      { ...change, at: now().toISOString(), ...kari },
      ...(changes.get(service) ?? []),
    ]);
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
        ...(p.description ? { description: p.description } : {}),
      })),
  });

  return ({ path, url, method, body, reason, json, notFound, reasonMissing }) => {
    const history = /^\/tenants\/[^/]+\/services\/([^/]+)\/environment-history$/.exec(path);
    if (history && method === 'GET') {
      const service = decodeURIComponent(history[1] ?? '');
      if (options.latest?.(service) === undefined) return notFound();
      const environment = url.searchParams.get('environment');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const all = (changes.get(service) ?? []).filter(
        (c) => !environment || c.environment === environment,
      );
      return json({ data: all.slice(0, limit), total: all.length });
    }
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
      const reasonText = reason ?? '';
      for (const env of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const was = before[env];
        const is = after[env];
        const version = is ? (is.version ?? null) : null;
        const previousVersion = was ? (was.version ?? latest) : null;
        if (!was && is)
          record(service, {
            environment: env,
            action: 'added',
            version,
            previousVersion: null,
            reason: reasonText,
          });
        else if (was && !is)
          record(service, {
            environment: env,
            action: 'removed',
            version: null,
            previousVersion,
            reason: reasonText,
          });
        else if (method === 'PATCH' && env === name)
          record(service, {
            environment: env,
            action: 'described',
            version,
            previousVersion: was?.previousVersion ?? null,
            reason: reasonText,
          });
        else if (was && is && was.version !== is.version && env === name)
          record(service, {
            environment: env,
            action: match[3] === 'promote' ? 'promoted' : 'rolled-back',
            version,
            previousVersion,
            ...(match[3] === 'promote' ? { from: body<{ from?: string }>().from ?? 'test' } : {}),
            reason: reasonText,
          });
      }
      return json(view(service, latest), status);
    };
    const refuse = (r: ReturnType<typeof invalid>) => json(r.body, r.status);
    if (method === 'POST' && !name) {
      const { name: wanted = '', description } = body<{ name?: string; description?: string }>();
      if (wanted in before) return refuse(invalid('state', `${wanted} exists`, 409));
      const prod = before.prod ?? {};
      return reply(
        {
          ...before,
          prod: prod.version === undefined ? { ...prod, version: latest } : prod,
          [wanted]: description?.trim() ? { description: description.trim() } : {},
        },
        201,
      );
    }
    if (!name || !(name in before)) return notFound();
    if (method === 'PATCH') {
      const description = body<{ description?: string | null }>().description?.trim();
      const rest: Pointer = { ...before[name] };
      delete rest.description;
      return reply({ ...before, [name]: description ? { ...rest, description } : rest });
    }
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
        [name]: { ...before[name], version: source.version ?? latest, previousVersion: current },
      });
    }
    const version = body<{ version?: number }>().version ?? before[name]?.previousVersion;
    if (version === undefined) return refuse(invalid('version', 'no earlier version'));
    return reply({ ...before, [name]: { ...before[name], version, previousVersion: current } });
  };
};
