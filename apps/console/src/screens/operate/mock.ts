import { exampleOperations } from '../../example-data';
import type { FailedRun, Incident, RunTimeline } from '../../operator-types';
import type { AuditEntry, Tenant } from '../../types';

type Json = (body: unknown, status?: number) => Response;

export interface OperateMockContext {
  now: () => Date;
  tenants: () => Tenant[];
  log: () => AuditEntry[];
  recordAction: (action: string, target: string, reason?: string) => void;
  failedRuns: (now: Date) => FailedRun[];
}

export type ContentRead = (tenant: string, target: string) => Response | undefined;

const waiting: Record<string, NonNullable<Tenant['waiting']>> = {
  '974222333': { count: 1, blocks: true, types: ['quota'] },
  '983888999': { count: 1, blocks: true, types: ['quota'] },
  '983555666': { count: 1, blocks: false, types: ['work-instruction'] },
  '910111222': { count: 1, blocks: false, types: ['suggestion'] },
  '999888777': { count: 1, blocks: true, types: ['catalogue'] },
  '964777888': { count: 1, blocks: true, types: ['access'] },
};

const at = (now: Date, hours: number, minutes: number) => {
  const d = new Date(now);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
};

const stepCause: Record<string, string> = {
  't-091': 'Tidsavbrudd etter 30 s',
  't-084': 'Tidsavbrudd etter 30 s',
};

const daysAgo = (now: Date, days: number, hours: number, minutes: number) => {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
};

type SampleRow = [string, string, boolean, string, string, string, string];

const sampleAudit = (now: Date): AuditEntry[] =>
  (<SampleRow[]>[
    [
      daysAgo(now, 1, 9, 15),
      'Lise Dahl',
      true,
      '974222333',
      'platform.setting.set',
      'Endret grense: tokens per måned 40 → 60 mill.',
      'Godkjent etter forespørsel',
    ],
    [
      daysAgo(now, 1, 8, 40),
      'Jon Øien',
      true,
      '999888777',
      'platform.content.read',
      'Så innhold',
      'Sak DIG-4507, tregt svar i Rapportassistenten',
    ],
    [
      daysAgo(now, 2, 15, 2),
      'Kari Nordmann',
      false,
      '999888777',
      'platform.block-share.request',
      'Ba om deling av designelement',
      'Andre etater med registerdata kan bruke den',
    ],
    [
      daysAgo(now, 6, 11, 12),
      'Jon Øien',
      true,
      '974222333',
      'platform.content.read',
      'Så innhold',
      'Sak DIG-4488, feil i Spør regelverket',
    ],
    [
      daysAgo(now, 14, 10, 3),
      'Lise Dahl',
      true,
      '999888777',
      'platform.flag.tenant.set',
      'Funksjonsbryter: Utforming på',
      'Pilot for designelementer',
    ],
    [
      daysAgo(now, 55, 13, 30),
      'Lise Dahl',
      true,
      '986666777',
      'platform.tenant.status',
      'Satte virksomheten på pause',
      'Etter ønske fra virksomheten',
    ],
  ]).map(([when, name, digdir, tenant, action, label, reason], i) => ({
    task: `op-${i}`,
    tenant,
    action,
    actionLabel: label,
    actor: digdir ? `operator:${name}` : `employee:${name}`,
    actorName: name,
    ...(digdir ? { actorOrg: 'Digdir' } : {}),
    at: when,
    outcome: 'applied' as const,
    target: action,
    reason,
  }));

const osloDay = (iso: string) =>
  new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });

const timelineOf = (run: FailedRun): RunTimeline => {
  const cause = stepCause[run.task] ?? run.failure?.reason ?? '';
  return {
    id: run.task,
    service: run.service ?? '',
    serviceName: run.serviceName ?? '',
    version: 7,
    status: 'failed',
    trigger: 'chat',
    caller: 'employee:4f1c',
    startedAt: run.at,
    durationSeconds: 30.9,
    inputTokens: 4_512,
    outputTokens: 300,
    costOre: 0,
    steps: [
      {
        id: 's0',
        type: 'trigger',
        title: 'Mottok spørsmålet',
        summary: '',
        at: 0,
        blocks: [
          {
            kind: 'quote',
            text: 'Oppsummer høringssvarene om endring i forskrift om arkiv. Skill mellom kommuner og statlige virksomheter.',
          },
        ],
      },
      {
        id: 's1',
        type: 'search',
        title: 'Søkte i dokumentsamlingen Høringer 2026, 12 treff',
        summary: '',
        at: 0.5,
        blocks: [],
      },
      {
        id: 's2',
        type: 'model',
        title: 'Kalte Borealis-27B 2.1',
        summary: cause,
        at: 0.9,
        blocks: [],
        state: 'failed',
        model: 'Borealis-27B 2.1',
      },
    ],
  };
};

export const operateMock = (json: Json, ctx: OperateMockContext) => {
  const start = ctx.now();
  let incidents: Incident[] = [
    {
      id: 'inc-borealis',
      title: 'Borealis-27B svarer tregt',
      text: 'Svartiden er over 9 s for 3 virksomheter. Undersøker.',
      tenants: ['974222333', '999888777', '983555666'],
      startedAt: at(start, 9, 10),
    },
    {
      id: 'inc-pdf',
      title: 'Innlesing stoppet for PDF-er over 50 MB',
      text: 'Innlesingen stoppet for store PDF-er.',
      tenants: ['974222333', '983888999'],
      startedAt: daysAgo(start, 8, 9, 0),
      resolvedAt: daysAgo(start, 8, 12, 10),
    },
    {
      id: 'inc-login',
      title: 'Innlogging med ID-porten feilet',
      text: 'Innlogging feilet for alle.',
      tenants: [],
      startedAt: daysAgo(start, 20, 8, 0),
      resolvedAt: daysAgo(start, 20, 8, 42),
    },
  ];
  const needReason = () =>
    json(
      { title: 'Invalid request', status: 400, errors: [{ path: 'reason', message: 'reason' }] },
      400,
    );

  return (
    path: string,
    method: string,
    params: URLSearchParams,
    body: () => Record<string, unknown>,
    reason: string | null,
    contentRead: ContentRead,
  ): Response | undefined => {
    if (path === '/operator/tenants' && method === 'GET')
      return json({
        data: ctx.tenants().map((t) => ({
          ...t,
          ...(waiting[t.orgNumber] ? { waiting: waiting[t.orgNumber] } : {}),
        })),
      });
    if (path === '/operator/operations' && method === 'GET')
      return json({
        ...exampleOperations,
        components: [
          { name: 'API', status: 'normal' },
          { name: 'Kjøringer', status: 'normal', errorRate: '2,1 %' },
          { name: 'Innlesing', status: 'normal', errorRate: '0,6 %' },
          { name: 'Modeller: Borealis-27B 2.1', status: 'degraded', p95: '9,4 s' },
          { name: 'Modeller: GPT-4.1 (EU)', status: 'normal', p95: '2,1 s' },
          { name: 'Modeller: Qwen3.8-27B 1.3', status: 'normal', p95: '3,0 s' },
        ],
      });
    if (path === '/operator/incidents' && method === 'GET') return json({ data: incidents });
    if (path === '/operator/incidents' && method === 'POST') {
      if (!reason) return needReason();
      const b = body() as { title?: string; text?: string; tenants?: string[] };
      const incident: Incident = {
        id: `inc-${incidents.length + 1}`,
        title: String(b.title ?? ''),
        text: String(b.text ?? ''),
        tenants: b.tenants ?? [],
        startedAt: ctx.now().toISOString(),
      };
      incidents = [incident, ...incidents];
      ctx.recordAction('platform.incident.save', `incident:${incident.id}`, reason);
      return json(incident, 201);
    }
    const resolve = /^\/operator\/incidents\/([^/]+)\/resolve$/.exec(path);
    if (resolve && method === 'POST') {
      if (!reason) return needReason();
      const found = incidents.find((i) => i.id === resolve[1]);
      if (!found) return json({ title: 'Not found', status: 404 }, 404);
      if (found.resolvedAt)
        return json(
          { type: 'urn:genai:problem:incident-resolved', title: 'Conflict', status: 409 },
          409,
        );
      const next = { ...found, resolvedAt: ctx.now().toISOString() };
      incidents = incidents.map((i) => (i === found ? next : i));
      ctx.recordAction('platform.incident.resolve', `incident:${found.id}`, reason);
      return json(next);
    }
    if (path === '/operator/audit' && method === 'GET') {
      const from = params.get('from');
      const to = params.get('to');
      const tenant = params.get('tenant');
      const action = params.get('action');
      const by = params.get('by');
      const all = [...ctx.log(), ...sampleAudit(ctx.now())]
        .filter(
          (e) =>
            (!tenant || e.tenant === tenant) &&
            (!action || e.action.startsWith(action)) &&
            (!by || e.actor.startsWith('operator:') === (by === 'operator')) &&
            (!from || osloDay(e.at) >= from) &&
            (!to || osloDay(e.at) <= to),
        )
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const offset = Number(params.get('offset') ?? 0);
      const limit = Number(params.get('limit') ?? all.length);
      return json({ data: all.slice(offset, offset + limit), total: all.length });
    }
    const timeline = /^\/tenants\/(\d{9})\/tasks\/([^/]+)\/timeline$/.exec(path);
    const run = timeline
      ? ctx.failedRuns(ctx.now()).find((r) => r.task === timeline[2] && r.tenant === timeline[1])
      : undefined;
    if (run) {
      const refused = contentRead(run.tenant, `task/${run.task}/timeline`);
      return refused ?? json(timelineOf(run));
    }
    return undefined;
  };
};
