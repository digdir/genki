import type { Hook, HookList, HookSpec } from '../api/hooks';
import type { MockHandler } from '../mock';

export interface HooksMockOptions {
  hooks?: Hook[];
}

const builtins: HookList['builtins'] = [
  {
    id: 'block-terms',
    title: 'Stopp ord og uttrykk',
    description: 'Stopper kallet når teksten inneholder et av ordene.',
  },
  {
    id: 'max-length',
    title: 'Største lengde',
    description: 'Stopper kallet når teksten er lengre enn grensen.',
  },
  { id: 'tag', title: 'Merk kjøringen', description: 'Legger faste merker på kjøringen.' },
  { id: 'measure', title: 'Mål lengde', description: 'Teller tegn i teksten.' },
];

const points: HookList['points'] = [
  'before_model',
  'after_model',
  'before_tool',
  'after_tool',
  'task_completed',
  'on_publish',
  'before_search',
  'after_search',
  'on_feedback',
];

export const exampleHooks = (): Hook[] => [
  {
    id: 'fodselsnummer',
    scope: '991825827',
    name: 'Stopp fødselsnummer før modellen',
    point: 'before_model',
    mode: 'enforce',
    failure: 'open',
    timeoutMs: 2000,
    order: 10,
    enabled: true,
    handler: { kind: 'builtin', id: 'block-terms', config: { terms: ['fødselsnummer'] } },
    version: 1,
    changedBy: 'Kari Nordmann',
    changedAt: '2026-10-06T09:12:00Z',
  },
];

export const hooksMock = (options: HooksMockOptions = {}): MockHandler => {
  let hooks = structuredClone(options.hooks ?? exampleHooks());
  return (req) => {
    const route = /^\/tenants\/([^/]+)\/hooks(?:\/([^/]+))?(\/test)?$/.exec(req.path);
    if (!route) return undefined;
    const tenant = route[1] ?? '';
    const id = route[2] ? decodeURIComponent(route[2]) : undefined;
    if (!id && req.method === 'GET')
      return req.json({ data: hooks, platform: [], points, builtins } satisfies HookList);
    const found = hooks.find((h) => h.id === id);
    if (id && route[3] && req.method === 'POST') {
      if (!found) return req.notFound();
      const payload = { text: 'Saken gjelder 010190 12345 …' };
      return req.json(
        found.mode === 'enforce'
          ? {
              refused: {
                name: found.name,
                reason: 'Spørsmålet ser ut til å inneholde et fødselsnummer.',
              },
              records: [{ outcome: 'refused', ms: 212 }],
              payload,
            }
          : { records: [{ outcome: 'allowed', ms: 212 }], payload },
      );
    }
    if (!req.reason) return req.reasonMissing();
    if (id && req.method === 'PUT') {
      const spec = req.body<HookSpec>();
      if (!spec.name?.trim())
        return req.json(
          {
            title: 'Ugyldig forespørsel',
            status: 400,
            errors: [{ path: 'spec.name', message: 'required' }],
          },
          400,
        );
      const saved: Hook = {
        ...spec,
        id,
        scope: tenant,
        version: (found?.version ?? 0) + 1,
        changedBy: 'Deg',
        changedAt: new Date().toISOString(),
      };
      hooks = [...hooks.filter((h) => h.id !== id), saved];
      return req.json(saved);
    }
    if (id && req.method === 'DELETE') {
      if (!found) return req.notFound();
      hooks = hooks.filter((h) => h.id !== id);
      return req.json({ removed: id });
    }
    return undefined;
  };
};
