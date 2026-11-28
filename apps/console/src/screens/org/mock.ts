import { flags } from '@genai/contracts/flags';
import type {
  FailedRun,
  FlagRowView,
  InboxItem,
  TenantOverview,
  UsageNumbers,
} from '../../operator-types';
import type { AuditEntry, OperatorFlag, QuotaRequestRow, Tenant } from '../../types';

type FlagRow = OperatorFlag['rows'][number] & { key: string; expiresAt?: string };

export interface OrgMockContext {
  now: () => Date;
  tenants: () => Tenant[];
  log: () => AuditEntry[];
  quotaOf: (tenant: string) => number | undefined;
  quotaRequests: () => (QuotaRequestRow & { postponedUntil?: string })[];
  flagRows: () => FlagRow[];
  contentRead: (tenant: string, target: string) => Response | undefined;
}

const sample = '974222333';
const dayMs = 86_400_000;
const mill = 1_000_000;
const kr = 1_000_000;

const ago = (now: Date, days: number, hours = 0) =>
  new Date(now.getTime() - days * dayMs - hours * 3_600_000).toISOString();

const usage = (tokens: number, cost: number | null): UsageNumbers => ({
  inputTokens: Math.round(tokens * 0.8),
  outputTokens: tokens - Math.round(tokens * 0.8),
  requests: Math.round(tokens / 4000),
  costMicroNok: cost === null ? null : Math.round(cost * kr),
});

const services: [string, string, number | null, number | null, string][] = [
  ['hoeringsanalyse', 'Høringsanalyse', 7, 8, 'active'],
  ['svarbrev', 'Utkast til svarbrev', 3, 3, 'active'],
  ['regelverk', 'Spør regelverket', 12, 13, 'active'],
  ['saksoppsummering', 'Saksoppsummering', 2, 2, 'active'],
  ['klarsprak-vedtak', 'Klarspråk i vedtak', 1, 1, 'active'],
  ['tilskudd', 'Tilskuddsveileder', 4, 4, 'paused'],
  ['innsynskrav', 'Innsynskrav', null, 1, 'active'],
  ['postmottak', 'Postmottak', 5, 5, 'active'],
  ['arkivsok', 'Arkivsøk', 2, 2, 'active'],
  ['moteref', 'Møtereferat', 3, 4, 'active'],
  ['statistikk', 'Statistikkhjelp', 1, 1, 'active'],
  ['oversetter', 'Oversetter', 2, 2, 'active'],
  ['kurs', 'Kursassistent', null, 2, 'active'],
  ['hr', 'Personalhåndbok', 6, 6, 'active'],
];

const serviceUse: Record<string, [number, number, number]> = {
  hoeringsanalyse: [14.2, 118, 2],
  svarbrev: [9.8, 74, 0],
  regelverk: [6.1, 45, 1],
};
const otherUse: [number, number] = [3.8, 25];
const dailyShape = [
  0.4, 1.6, 1.7, 1.8, 1.7, 1.5, 0.4, 0.3, 1.8, 1.9, 2.0, 1.9, 1.6, 0.4, 0.4, 2.1, 2.2, 2.3, 2.2,
  2.0, 0.5, 0.4, 2.4, 2.6, 2.5,
];

export const monthEndForecast = (used: number, now: Date) => {
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const elapsed = Math.max((now.getTime() - start) / dayMs, 1);
  return Math.round((used * ((end - start) / dayMs)) / elapsed);
};

export const orgMock = (
  json: (body: unknown, status?: number) => Response,
  ctx: OrgMockContext,
) => {
  const tenantName = (org: string) => ctx.tenants().find((t) => t.orgNumber === org)?.name ?? org;
  const start = ctx.now();
  const flagSeed: FlagRow[] = [
    {
      key: 'blockStudio',
      tenant: sample,
      on: true,
      by: 'operator:entra:lise',
      byName: 'Lise Dahl',
      at: ago(start, 14),
      reason: 'Piloten for designelementer',
      expiresAt: new Date(start.getFullYear(), 11, 31, 12).toISOString(),
    },
    {
      key: 'blockStudio',
      tenant: sample,
      person: { issuer: 'ansattporten', subject: 'marte' },
      personName: 'Marte Solheim',
      on: false,
      by: 'employee:ansattporten:bjorn',
      byName: 'Bjørn Aas',
      at: ago(start, 6),
      reason: 'Venter til opplæringen er ferdig',
    },
  ];
  let seededFlags = flagSeed;
  const auditSeed: AuditEntry[] = [
    {
      task: 'a-org-1',
      tenant: sample,
      action: 'platform.service.publish',
      actionLabel: 'Publiserte Høringsanalyse, utgave 7',
      actor: 'employee:ansattporten:bjorn',
      actorName: 'Bjørn Aas',
      at: ago(start, 12),
      outcome: 'applied',
      target: 'service:hoeringsanalyse',
      reason: 'Ny utgave med bedre kildehenvisninger',
    },
    {
      task: 'a-org-2',
      tenant: sample,
      action: 'platform.flag.person',
      actionLabel: 'Slo av Utforming for Marte Solheim',
      actor: 'employee:ansattporten:bjorn',
      actorName: 'Bjørn Aas',
      at: ago(start, 6, 2),
      outcome: 'applied',
      target: 'flag:blockStudio',
      reason: '',
      flag: { key: 'blockStudio', on: false, person: { self: false, name: 'Marte Solheim' } },
    },
    {
      task: 'a-org-4',
      tenant: sample,
      action: 'platform.quota.request',
      actionLabel: 'Ba om 80 mill. tokens per måned',
      actor: 'employee:ansattporten:bjorn',
      actorName: 'Bjørn Aas',
      at: ago(start, 2, 4),
      outcome: 'applied',
      target: 'quota-request:974222333/qr-eksempeldirektoratet',
      reason: 'Saksbehandlingsassistenten går i drift for alle avdelinger i desember',
    },
    {
      task: 'a-org-3',
      tenant: sample,
      onBehalfOf: sample,
      action: 'platform.content.read',
      actor: 'operator:entra:jon',
      actorName: 'Jon Øien',
      actorOrg: 'Digdir',
      at: ago(start, 6),
      outcome: 'applied',
      target: 'content:task/t-077',
      reason: 'Sak DIG-4488, feil i Spør regelverket',
    },
  ];
  const auditOf = (org: string) =>
    [...(org === sample ? auditSeed : []), ...ctx.log().filter((e) => e.tenant === org)].sort(
      (a, b) => a.at.localeCompare(b.at),
    );

  const startOfDay = (now: Date) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const today = (now: Date, minutes: number) =>
    new Date(
      Math.max(
        now.getTime() - minutes * 60_000,
        startOfDay(now).getTime() + (600 - minutes) * 1000,
      ),
    ).toISOString();
  const failedRun = (
    task: string,
    tenant: string,
    service: string,
    serviceName: string,
    at: string,
    code: string,
    reason: string,
  ): FailedRun => ({
    task,
    tenant,
    tenantName: tenantName(tenant),
    service,
    serviceName,
    at,
    failure: { code, reason },
  });
  const failedRuns = (now: Date) =>
    [
      failedRun(
        't-091',
        sample,
        'hoeringsanalyse',
        'Høringsanalyse',
        today(now, 60),
        'timeout',
        'Tidsavbrudd mot Borealis-27B 2.1',
      ),
      failedRun(
        't-088',
        '999888777',
        'rapportassistenten',
        'Rapportassistenten',
        today(now, 75),
        'tool',
        'Verktøyet svarte 502',
      ),
      failedRun(
        't-074',
        '983555666',
        'klagesaker',
        'Klagesaker',
        today(now, 160),
        'retrieval',
        'Fant ingen kilder i dokumentsamlingen',
      ),
      failedRun(
        't-084',
        sample,
        'hoeringsanalyse',
        'Høringsanalyse',
        ago(now, 2, 3),
        'timeout',
        'Tidsavbrudd mot Borealis-27B 2.1',
      ),
      failedRun(
        't-077',
        sample,
        'regelverk',
        'Spør regelverket',
        ago(now, 6, 1),
        'retrieval',
        'Fant ingen kilder i dokumentsamlingen',
      ),
    ].sort((a, b) => b.at.localeCompare(a.at));

  const quotaNow = (org: string) => {
    const tenant = ctx.tenants().find((t) => t.orgNumber === org);
    const own = ctx.quotaOf(org);
    const monthly = own ?? (tenant?.quotaMillions ?? 0) * mill;
    return tenant
      ? { usedTokens: Math.round((tenant.tokensMillions ?? 0) * mill), monthlyTokens: monthly }
      : undefined;
  };

  const inbox = (now: Date): InboxItem[] => {
    const quota = ctx
      .quotaRequests()
      .filter(
        (r) => r.state === 'pending' && !(r.postponedUntil && r.postponedUntil > now.toISOString()),
      )
      .map((r): InboxItem => {
        const q = quotaNow(r.tenant);
        return {
          type: 'quota',
          id: r.id,
          tenant: r.tenant,
          tenantName: r.tenantName,
          what: 'usage.monthlyTokens',
          from: r.requestedByName ?? r.requestedBy,
          waitingSince: r.requestedAt,
          blocks: q ? q.usedTokens * 100 >= 90 * q.monthlyTokens : false,
          action: {
            method: 'POST',
            path: `/operator/quota-requests/${r.tenant}/${r.id}/decision`,
          },
          detail: {
            monthlyTokens: r.monthlyTokens,
            ...(q ? { usedTokens: q.usedTokens, currentMonthlyTokens: q.monthlyTokens } : {}),
          },
        };
      });
    const fixed: InboxItem[] = [
      {
        type: 'access',
        id: 'onb-testby',
        tenant: '964777888',
        tenantName: tenantName('964777888'),
        what: 'Testby kommune',
        from: 'Elin Haug',
        waitingSince: ago(now, 54),
        blocks: true,
        action: { method: 'POST', path: '/operator/onboarding/requests/964777888/decision' },
      },
      {
        type: 'catalogue',
        id: 'share-figur',
        tenant: '999888777',
        tenantName: tenantName('999888777'),
        what: 'Figur i svaret',
        from: 'Kari Nordmann',
        waitingSince: ago(now, 4),
        blocks: true,
        action: { method: 'POST', path: '/operator/block-share-requests/share-figur/approve' },
        detail: { kind: 'block-share', block: 'figur', version: 2 },
      },
      {
        type: 'work-instruction',
        id: '983555666:klagesaker',
        tenant: '983555666',
        tenantName: tenantName('983555666'),
        what: 'Klagesaker',
        from: 'Arne Holm',
        waitingSince: ago(now, 3),
        blocks: false,
        action: { method: 'POST', path: '/operator/skills/shares/983555666%3Aklagesaker/decision' },
      },
      {
        type: 'suggestion',
        id: 'p-nynorsk',
        tenant: '910111222',
        tenantName: tenantName('910111222'),
        what: 'Svar på nynorsk',
        from: 'Hanne Lund',
        waitingSince: ago(now, 1, 2),
        blocks: false,
        action: { method: 'POST', path: '/operator/proposals/p-nynorsk/decision' },
      },
      {
        type: 'incident',
        id: 'inc-borealis',
        tenant: null,
        tenants: [sample, '999888777', '910111222'],
        what: 'Borealis-27B svarer tregt',
        from: null,
        waitingSince: ago(now, 0, 5),
        blocks: true,
        action: { method: 'POST', path: '/operator/incidents/inc-borealis/resolve' },
      },
      {
        type: 'expiring',
        id: 'blockStudio:999888777',
        tenant: '999888777',
        tenantName: tenantName('999888777'),
        what: 'blockStudio',
        from: 'Lise Dahl',
        waitingSince: ago(now, 14),
        due: new Date(now.getTime() + 5 * dayMs).toISOString(),
        blocks: false,
        action: { method: 'PUT', path: '/operator/flags/blockStudio' },
      },
    ];
    return [...quota, ...fixed].sort(
      (a, b) =>
        (a.due === undefined ? 0 : 1) - (b.due === undefined ? 0 : 1) ||
        (a.due ?? a.waitingSince).localeCompare(b.due ?? b.waitingSince),
    );
  };

  const overview = (org: string, now: Date): TenantOverview | undefined => {
    const tenant = ctx.tenants().find((t) => t.orgNumber === org);
    if (!tenant) return undefined;
    const q = quotaNow(org);
    const waiting = inbox(now).filter((i) => i.tenant === org);
    const near = q && q.monthlyTokens > 0 && q.usedTokens * 100 >= 90 * q.monthlyTokens;
    return {
      orgNumber: org,
      name: tenant.name,
      status: tenant.status,
      ...(tenant.admin && tenant.status !== 'onboarding' ? { admin: tenant.admin } : {}),
      needsAction: [
        ...waiting,
        ...(near && !waiting.some((i) => i.type === 'quota')
          ? [
              {
                type: 'quota' as const,
                id: `quota-limit:${org}`,
                tenant: org,
                what: 'usage.monthlyTokens',
                from: null,
                waitingSince: now.toISOString(),
                blocks: true,
                action: { method: 'PUT', path: `/tenants/${org}/settings/usage.monthlyTokens` },
                detail: { usedTokens: q.usedTokens, currentMonthlyTokens: q.monthlyTokens },
              },
            ]
          : []),
      ],
      tokens:
        q && q.monthlyTokens > 0
          ? {
              ...q,
              usedPercent: Math.round((q.usedTokens / q.monthlyTokens) * 1000) / 10,
              forecastTokens: org === sample ? 46 * mill : monthEndForecast(q.usedTokens, now),
            }
          : null,
      cost: {
        from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        costMicroNok:
          tenant.costNok === undefined || tenant.costNok === null ? null : tenant.costNok * kr,
        priced: true,
      },
      services: { total: tenant.services, inUse: tenant.servicesActive ?? tenant.services },
      failedRunsLast7Days: failedRuns(now).filter((r) => r.tenant === org && r.at >= ago(now, 7))
        .length,
      latestAudit: auditOf(org).slice().reverse().slice(0, 5),
    };
  };

  const usageFor = (org: string, days: number, now: Date) => {
    const scale = org === sample ? days / Math.max(1, now.getDate()) : 0.1 * (days / 30);
    const daily = Array.from({ length: days }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i), 12);
      const shape = dailyShape[(d.getDate() - 1) % dailyShape.length] ?? 1;
      return {
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        usage: usage(Math.round(shape * mill * (org === sample ? 1 : 0.1)), null),
      };
    });
    const named = services.filter(([id]) => serviceUse[id]);
    const rest = services.filter(([id]) => !serviceUse[id]);
    const byService = [
      ...named.map(([id, title]) => {
        const [tokens, cost, failed] = serviceUse[id] ?? [0, 0, 0];
        return {
          service: id,
          title,
          usage: {
            ...usage(Math.round(tokens * mill * scale), cost * scale),
            runs: 40,
            failedRequests: days <= 7 ? failed : failed * 3,
          },
        };
      }),
      ...rest.map(([id, title]) => ({
        service: id,
        title,
        usage: {
          ...usage(
            Math.round(((otherUse[0] * mill) / rest.length) * scale),
            (otherUse[1] / rest.length) * scale,
          ),
          runs: 5,
          failedRequests: 0,
        },
      })),
    ];
    const testing = usage(Math.round(2.7 * mill * scale), 21 * scale);
    const ingestion = usage(Math.round(2.0 * mill * scale), 27 * scale);
    const all = [...byService.map((s) => s.usage), testing, ingestion];
    const sum = (k: 'inputTokens' | 'outputTokens' | 'requests') =>
      all.reduce((n, u) => n + u[k], 0);
    return {
      from: daily[0]?.date,
      to: daily.at(-1)?.date,
      priced: true,
      totals: {
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        requests: sum('requests'),
        costMicroNok: all.reduce((n, u) => n + (u.costMicroNok ?? 0), 0),
        runs: 100,
        failedRequests: 3,
      },
      daily,
      byService,
      byModel: [
        { model: 'Borealis-27B 2.1', usage: usage(Math.round(23.5 * mill * scale), 69 * scale) },
        { model: 'GPT-4.1 (EU)', usage: usage(Math.round(13.1 * mill * scale), 214 * scale) },
        {
          model: 'text-embedding-3-large (EU)',
          usage: usage(Math.round(2.0 * mill * scale), 27 * scale),
        },
      ],
      ingestion: { usage: ingestion, byDataset: [] },
      testing: { usage: testing, byOrigin: [] },
    };
  };

  const flagsFor = (org: string) => {
    const live = ctx.flagRows().filter((r) => r.tenant === org);
    const seeded = seededFlags.filter(
      (s) =>
        !live.some(
          (r) =>
            r.key === s.key &&
            r.person?.issuer === s.person?.issuer &&
            r.person?.subject === s.person?.subject,
        ),
    );
    const rows = [...live, ...seeded];
    const view = (r: FlagRow): FlagRowView => ({
      ...(r.person ? { person: r.person } : {}),
      ...(r.personName ? { personName: r.personName } : {}),
      on: r.on,
      by: r.by,
      ...(r.byName ? { byName: r.byName } : {}),
      at: r.at,
      reason: r.reason,
      ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
      expired: false,
    });
    return Object.entries(flags).map(([key, spec]) => {
      const tenantRow = rows.find((r) => r.key === key && !r.person);
      return {
        key,
        ...spec,
        on: tenantRow?.on ?? false,
        source: tenantRow ? 'tenant' : 'default',
        tenant: tenantRow ? view(tenantRow) : null,
        people: rows.filter((r) => r.key === key && r.person).map(view),
      };
    });
  };

  const definitions = (now: Date) =>
    services.map(([id, name, live, test, state]) => ({
      kind: 'Service',
      id,
      name,
      state,
      latestVersion: Math.max(live ?? 0, test ?? 0),
      liveVersion: live,
      testVersion: test,
      publishedAt: live === null ? null : ago(now, 12),
      publishedBy: live === null ? null : 'employee:ansattporten:bjorn',
      publishedByName: 'Bjørn Aas',
    }));

  const handle = (
    path: string,
    method: string,
    search: URLSearchParams,
    body: () => Record<string, unknown>,
    reason: string | null,
  ): Response | undefined => {
    const now = ctx.now();
    if (path === '/operator/inbox' && method === 'GET') return json({ data: inbox(now) });
    if (path === '/operator/failed-runs' && method === 'GET') {
      const from = search.get('from') ?? startOfDay(now).toISOString();
      return json({ from, data: failedRuns(now).filter((r) => r.at >= from) });
    }
    const flagPut = /^\/operator\/flags\/([^/]+)$/.exec(path);
    if (flagPut && method === 'PUT' && reason) {
      const change = body() as { tenant?: string; person?: { issuer: string; subject: string } };
      seededFlags = seededFlags.filter(
        (s) =>
          !(
            s.key === decodeURIComponent(flagPut[1] ?? '') &&
            s.tenant === change.tenant &&
            s.person?.issuer === change.person?.issuer &&
            s.person?.subject === change.person?.subject
          ),
      );
      return undefined;
    }
    const tenantPath = /^\/operator\/tenants\/(\d{9})(\/[a-z-]+)?$/.exec(path);
    if (tenantPath && method === 'GET') {
      const [, org = '', rest] = tenantPath;
      if (!rest) {
        const found = overview(org, now);
        return found ? json(found) : json({ title: 'Not found', status: 404 }, 404);
      }
      if (rest === '/flags') return json({ data: flagsFor(org) });
      if (rest === '/hostnames')
        return json({
          data:
            org === sample
              ? [
                  {
                    hostname: 'hoeringsanalyse.eksempeldir.no',
                    client: 'hoeringsanalyse',
                    service: 'hoeringsanalyse',
                    state: 'active',
                  },
                ]
              : [],
        });
      if (rest === '/private-networks')
        return json({ tenant: org, entries: org === sample ? ['arkiv.eksempeldir.no'] : [] });
      if (rest === '/definitions' && org === sample) return json({ data: definitions(now) });
      return undefined;
    }
    const usagePath = /^\/tenants\/(\d{9})\/usage$/.exec(path);
    if (usagePath && method === 'GET') {
      const days = Math.min(366, Math.max(1, Number(search.get('days') ?? 30) || 30));
      return json(usageFor(usagePath[1] ?? '', days, now));
    }
    const peoplePath = /^\/tenants\/(\d{9})\/access\/people$/.exec(path);
    if (peoplePath && method === 'GET') {
      const org = peoplePath[1] ?? '';
      const refused = ctx.contentRead(org, 'access/people');
      if (refused) return refused;
      return json({
        people:
          org === sample
            ? [
                {
                  id: 'p-bjorn',
                  name: 'Bjørn Aas',
                  rights: ['use-services', 'manage-services', 'view-usage'],
                  lastLogin: ago(now, 0),
                },
                {
                  id: 'p-marte',
                  name: 'Marte Solheim',
                  rights: ['use-services', 'manage-datasets'],
                  lastLogin: ago(now, 2),
                },
                {
                  id: 'p-ola',
                  name: 'Ola Brekke',
                  rights: ['use-services'],
                  lastLogin: ago(now, 8),
                },
              ]
            : [],
        at: now.toISOString(),
        stale: false,
        source: 'test-data',
      });
    }
    const auditPath = /^\/tenants\/(\d{9})\/audit$/.exec(path);
    if (auditPath && method === 'GET') {
      const from = search.get('from');
      const to = search.get('to');
      const by = search.get('by');
      const action = search.get('action');
      const data = auditOf(auditPath[1] ?? '').filter(
        (e) =>
          (!from || e.at.slice(0, 10) >= from) &&
          (!to || e.at.slice(0, 10) <= to) &&
          (!action || e.action.startsWith(action)) &&
          (!by || e.actor.startsWith('operator:') === (by === 'operator')),
      );
      return json({ data, total: data.length });
    }
    return undefined;
  };
  return Object.assign(handle, { failedRuns });
};
