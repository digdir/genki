import type { AuditRow } from '../api';
import type { TenantStatus } from '../api/platform-status';
import { quotaRequestPendingType, type QuotaRequestView } from '../api/quota-requests';
import type { MockHandler } from '../mock';
import type { ToolConnectionView } from '../types';

export interface PlatformStatusMockOptions {
  status?: TenantStatus;
  quotaRequests?: QuotaRequestView[];
  toolConnections?: ToolConnectionView[];
  audit?: AuditRow[];
  email?: string;
}

export const exampleTenantStatus: TenantStatus = {
  incidents: [],
  components: [
    { name: 'API', status: 'normal' },
    { name: 'Database', status: 'normal', note: 'Svarte på 4 ms.' },
    { name: 'Modeller: azure-norway', status: 'normal', note: '3 av 3 modeller i bruk.' },
    { name: 'Kjøringer', status: 'normal', errorRate: '1,2 %' },
    { name: 'Innlesing', status: 'normal' },
  ],
  queueStats: [
    { label: 'Innlesinger som kjører', value: '0' },
    { label: 'Innlesinger som feilet siste døgn', value: '0' },
    { label: 'Kjøringer som pågår', value: '0' },
  ],
  queue: [],
  triggers: [],
};

export const exampleToolConnections: ToolConnectionView[] = [
  { id: 'arkiv', name: 'Arkivsøk', lastSync: { at: '2026-10-06T06:00:00Z', ok: true } },
];

const verbs = ['platform.service.publish', 'platform.setting.set', 'platform.apikeys.create'];

export const exampleAudit: AuditRow[] = Array.from({ length: 64 }, (_, i) => ({
  task: `audit-${i + 1}`,
  tenant: '999888777',
  action: verbs[i % verbs.length] ?? 'platform.service.publish',
  actor: 'person:kari',
  actorName: 'Kari Nordmann',
  at: new Date(Date.UTC(2026, 9, 6, 9, 0) - i * 3_600_000).toISOString(),
  outcome: 'applied',
  target: i % verbs.length === 1 ? 'answer.language' : 'rapportassistenten',
  reason: 'Eksempel på en endring',
}));

export const platformStatusMock = (options: PlatformStatusMockOptions = {}): MockHandler => {
  const requests = [...(options.quotaRequests ?? [])];
  const audit = [...(options.audit ?? exampleAudit)].sort((a, b) => a.at.localeCompare(b.at));
  return (req) => {
    if (req.path === '/me' && req.method === 'GET')
      return req.json({ email: options.email ?? 'kari.nordmann@testetaten.no' });
    const match = /^\/tenants\/([^/]+)\/(status|quota-requests|tool-connections|audit)$/.exec(
      req.path,
    );
    if (!match) return undefined;
    const tenant = decodeURIComponent(match[1] ?? '');
    const area = match[2];
    if (area === 'status' && req.method === 'GET')
      return req.json(options.status ?? exampleTenantStatus);
    if (area === 'tool-connections' && req.method === 'GET')
      return req.json({ data: options.toolConnections ?? exampleToolConnections });
    if (area === 'audit' && req.method === 'GET') {
      const limit = req.url.searchParams.get('limit');
      const offset = Number(req.url.searchParams.get('offset') ?? 0);
      if (limit === null && !req.url.searchParams.has('offset'))
        return req.json({ data: audit, total: audit.length });
      const newest = [...audit].reverse();
      return req.json({
        data: newest.slice(offset, offset + Number(limit ?? newest.length)),
        total: audit.length,
      });
    }
    if (area !== 'quota-requests') return undefined;
    if (req.method === 'GET') return req.json({ data: requests });
    if (req.method !== 'POST') return undefined;
    if (!req.reason) return req.reasonMissing();
    if (requests.some((r) => r.state === 'pending'))
      return req.json(
        {
          type: quotaRequestPendingType,
          title: 'Conflict',
          status: 409,
          errors: [{ path: 'state', message: 'a quota request is already waiting for a decision' }],
        },
        409,
      );
    const created: QuotaRequestView = {
      id: `qr-${requests.length + 1}`,
      monthlyTokens: req.body<{ monthlyTokens: number }>().monthlyTokens,
      reason: req.reason,
      requestedBy: `person:${tenant}`,
      requestedAt: new Date().toISOString(),
      state: 'pending',
    };
    requests.unshift(created);
    return req.json(created, 201);
  };
};
