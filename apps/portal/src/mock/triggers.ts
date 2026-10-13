import type { TriggerRunView, TriggerView } from '../api/triggers';
import type { MockHandler } from '../mock';

export interface TriggersMockOptions {
  triggers?: TriggerView[];
  runs?: Record<string, TriggerRunView[]>;
}

export const exampleTriggerViews = (): TriggerView[] => [
  {
    id: 'motereferat-7c1e9a40b2',
    service: 'motereferat',
    serviceName: 'Møtereferat',
    kind: 'document-arrives',
    target: 'teams-opptak',
    status: 'failing',
    lastRun: {
      id: 'kj-3',
      at: '2026-10-08T15:02:00Z',
      outcome: 'failed',
      error: 'the capability motereferat is not published',
    },
    runs7d: 4,
    failed7d: 1,
  },
  {
    id: 'nettsider-nynorsk-2b8f0d61c5',
    service: 'nettsider-nynorsk',
    serviceName: 'Nettsider på nynorsk',
    kind: 'schedule',
    target: '0 2 * * *',
    status: 'active',
    nextRunAt: '2026-10-10T00:00:00Z',
    lastRun: {
      id: 'kj-2',
      at: '2026-10-09T00:00:00Z',
      outcome: 'failed',
      task: 'opg_nn_0910',
      error: 'Publiseringssystemet svarte ikke (503)',
      timeline: '/tenants/999888777/tasks/opg_nn_0910/timeline',
    },
    runs7d: 7,
    failed7d: 1,
  },
  {
    id: 'postsortering-91d3a7e5f0',
    service: 'postsortering',
    serviceName: 'Postsortering',
    kind: 'queue-message',
    target: 'post-inn',
    status: 'active',
    lastRun: {
      id: 'kj-1',
      at: '2026-10-09T08:03:00Z',
      outcome: 'completed',
      task: 'opg_post_118',
      timeline: '/tenants/999888777/tasks/opg_post_118/timeline',
    },
    runs7d: 46,
    failed7d: 0,
  },
];

const exampleRuns = (): Record<string, TriggerRunView[]> => ({
  'postsortering-91d3a7e5f0': [
    {
      id: 'kj-1',
      at: '2026-10-09T08:03:00Z',
      outcome: 'completed',
      task: 'opg_post_118',
      timeline: '/tenants/999888777/tasks/opg_post_118/timeline',
    },
    {
      id: 'kj-0',
      at: '2026-10-09T07:41:00Z',
      outcome: 'completed',
      task: 'opg_post_117',
      timeline: '/tenants/999888777/tasks/opg_post_117/timeline',
    },
  ],
});

export const triggersMock = (options: TriggersMockOptions = {}): MockHandler => {
  let triggers = structuredClone(options.triggers ?? exampleTriggerViews());
  const runs = structuredClone(options.runs ?? exampleRuns());
  return (req) => {
    const route = /^\/tenants\/[^/]+\/triggers(?:\/([^/]+)\/(runs|pause))?$/.exec(req.path);
    if (!route) return undefined;
    const id = route[1] ? decodeURIComponent(route[1]) : undefined;
    if (!id && req.method === 'GET') return req.json({ data: triggers });
    const found = triggers.find((t) => t.id === id);
    if (!found) return req.notFound();
    if (route[2] === 'runs' && req.method === 'GET') {
      const recent = runs[found.id] ?? (found.lastRun ? [found.lastRun] : ([] as TriggerRunView[]));
      return req.json({ trigger: found, data: recent });
    }
    if (route[2] === 'pause' && req.method === 'PUT') {
      if (!req.reason) return req.reasonMissing();
      const { paused } = req.body<{ paused?: boolean }>();
      const next: TriggerView = paused
        ? { ...found, status: 'paused', pausedAt: new Date().toISOString() }
        : { ...found, status: 'active' };
      if (!paused) delete next.pausedAt;
      triggers = triggers.map((t) => (t.id === found.id ? next : t));
      return req.json(next);
    }
    return undefined;
  };
};
