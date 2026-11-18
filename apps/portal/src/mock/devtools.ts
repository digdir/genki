import type { ConfigEntry } from '../api';
import type { TraceConnection, TraceInstance } from '../api/tracing';
import type { MockHandler } from '../mock';

export interface DevtoolsMockOptions {
  tracing?: TraceConnection[];
  instance?: TraceInstance | null;
  guardrailRules?: ConfigEntry[];
}

export const exampleTracing: TraceConnection[] = [
  {
    id: 'digdir-langfuse',
    host: 'https://langfuse.digdir.example.no',
    publicKey: 'pk-lf-3c9e81a721ab',
    secretKey: 'secret://tenant/999888777/langfuse-digdir-langfuse',
    services: ['rapportassistenten'],
    residency: 'eu',
    content: false,
    erasureDeclared: false,
    labels: false,
    instance: true,
    residencySetBy: 'operator',
  },
];

export const exampleGuardrailRules: ConfigEntry[] = [
  {
    id: 'fjern-personnummer',
    scope: 'platform',
    version: 3,
    mandatory: true,
    builtin: false,
    spec: {
      kind: 'regex',
      pattern: '\\b\\d{11}\\b',
      stage: 'input',
      action: 'mask',
      mask: '[fjernet]',
      description: 'Bytter ut fødselsnumre med en plassholder før spørsmålet sendes til modellen.',
    },
  },
  {
    id: '999888777/ingen-helseraad',
    scope: '999888777',
    version: 1,
    mandatory: false,
    builtin: false,
    editable: true,
    spec: {
      kind: 'denylist',
      terms: ['diagnose', 'medisin'],
      stage: 'input',
      action: 'refuse',
      message: 'Spør fastlegen eller se helsenorge.no.',
      description: 'Kjenner igjen spørsmål om egen helse, sykdom og medisiner.',
    },
  },
];

export const devtoolsMock = (options: DevtoolsMockOptions = {}): MockHandler => {
  const instance = options.instance ?? undefined;
  const tracing = [...(options.tracing ?? [])];
  return (req) => {
    if (/^\/tenants\/[^/]+\/tracing\/connections$/.test(req.path) && req.method === 'GET')
      return req.json({ data: tracing, ...(instance ? { instance } : {}) });
    const one = /^\/tenants\/[^/]+\/tracing\/connections\/([^/]+)(\/check)?$/.exec(req.path);
    if (one?.[2] && req.method === 'POST')
      return req.json({ ok: true, project: { id: 'p1', name: 'Testetaten' } });
    if (one && req.method === 'PUT') {
      if (!req.reason) return req.reasonMissing();
      const id = decodeURIComponent(one[1] ?? '');
      const found = tracing.findIndex((c) => c.id === id);
      const saved = {
        ...(tracing[found] ?? { instance: false, residencySetBy: 'tenant', residency: 'global' }),
        ...req.body<Partial<TraceConnection>>(),
        id,
      } as TraceConnection;
      if (found >= 0) tracing[found] = saved;
      else tracing.push(saved);
      return req.json(saved);
    }
    if (/^\/tenants\/[^/]+\/guardrail-rules$/.test(req.path) && req.method === 'GET')
      return req.json({
        data: options.guardrailRules ?? exampleGuardrailRules,
        kinds: ['regex', 'denylist', 'llm-judge', 'mcp-check'],
        builtins: [],
      });
    return undefined;
  };
};
