import { parse as parseYaml } from 'yaml';
import type {
  DescriptorDetail,
  DescriptorFixture,
  EndpointProcessorRecord,
  InputShape,
  Maturity,
  OperationKind,
  OperatorModel,
  ProcessorRecord,
  WireExchange,
} from '../../types';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const problem = (status: number, errors: { path: string; message: string }[]) =>
  json({ type: 'about:blank', title: 'Invalid request', status, errors }, status);

const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const imageInput: InputShape = {
  kind: 'object',
  fields: {
    prompt: { kind: 'text' },
    size: { kind: 'optional', shape: { kind: 'enum', values: ['1024x1024', '1536x1024'] } },
  },
};

const classifyInput: InputShape = {
  kind: 'object',
  fields: { text: { kind: 'text' }, labels: { kind: 'array', item: { kind: 'plain' } } },
};

const passed = (fixtures: number) =>
  fixtures === 0
    ? null
    : { suite: 'operation@1', checks: fixtures * 7, passed: true, failures: [] };

type Entry = DescriptorDetail;

const seed = (): Entry[] => [
  {
    id: 'openai/decide@1',
    operation: 'decide',
    status: 'typed',
    source: 'bundled',
    summary: 'Azure OpenAI Decisions API',
    protocol: 'openai-chat',
    fixtures: 4,
    contract: passed(4),
    input: {
      kind: 'object',
      fields: {
        input: { kind: 'text' },
        questions: { kind: 'array', item: { kind: 'json' } },
      },
    },
    usedBy: [],
  },
  {
    id: 'openai/embed@1',
    operation: 'embed',
    status: 'typed',
    source: 'bundled',
    summary: 'OpenAI embeddings',
    protocol: 'openai-chat',
    fixtures: 2,
    contract: passed(2),
    input: { kind: 'object', fields: { input: { kind: 'array', item: { kind: 'text' } } } },
    usedBy: [],
  },
  {
    id: 'example/classify@1',
    operation: 'classify',
    status: 'described',
    source: 'uploaded',
    summary: 'A classification API for sorting incoming mail',
    protocol: 'openai-chat',
    fixtures: 1,
    contract: passed(1),
    input: classifyInput,
    usedBy: [{ tenant: '999888777', service: 'postsortering', version: 1 }],
    version: 2,
    by: 'operator:entra:lise',
    at: '2026-11-03T10:12:00Z',
    reason: 'Kontrakttesten er bestått på et lagret forsøk',
    document: { id: 'example/classify@1', operation: 'classify', status: 'described' },
    fixtureCases: [
      {
        name: 'faktura',
        source: 'recorded from the synthetic try t-try-1',
        input: { text: 'Jeg vil endre fakturaen', labels: ['billing', 'other'] },
      },
    ],
  },
  {
    id: 'openai/generate-image@1',
    operation: 'generate-image',
    status: 'review',
    source: 'uploaded',
    summary: 'Image generation through the Images API',
    protocol: 'openai-chat',
    fixtures: 0,
    contract: null,
    input: imageInput,
    usedBy: [],
    version: 1,
    by: 'operator:entra:lise',
    at: '2026-11-04T08:40:00Z',
    reason: 'Nytt bilde-API fra leverandøren',
    document: {
      id: 'openai/generate-image@1',
      operation: 'generate-image',
      status: 'review',
      summary: 'Image generation through the Images API',
    },
    fixtureCases: [],
  },
];

const masked = (text: string) =>
  text.replace(/\S+@\S+\.\S+/g, '«EMAIL»').replace(/\b\d{11}\b/g, '«FNR»');

const maskAll = (value: unknown): unknown => {
  if (typeof value === 'string') return masked(value);
  if (Array.isArray(value)) return value.map(maskAll);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskAll(v)]));
  return value;
};

const detailOnly = new Set(['input', 'usedBy', 'document', 'fixtureCases']);

const view = (e: Entry) =>
  Object.fromEntries(Object.entries(e).filter(([k]) => !detailOnly.has(k))) as Omit<
    Entry,
    'input' | 'usedBy' | 'document' | 'fixtureCases'
  >;

/** The operator routes for operation descriptors, kind maturity and processor records, offline. */
export const operationsMock = (models: () => OperatorModel[], environment: Maturity = 'test') => {
  let entries = seed();
  const maturity = new Map<string, Maturity>([['classify', 'production']]);
  const tries = new Map<string, { id: string; exchange: string }>();
  const records = new Map<string, ProcessorRecord>([
    [
      'foundry-openai',
      {
        agreement: 'DBA-2026-17',
        subProcessors: [{ name: 'Microsoft Ireland Operations Ltd', location: 'Sverige' }],
        retention: { days: 0 },
      },
    ],
  ]);

  const kinds = (): OperationKind[] => {
    const all = new Set(['chat', 'decide', ...entries.map((e) => e.operation)]);
    return [...all].sort().map((kind) => {
      const builtIn = kind === 'chat' || kind === 'decide';
      return {
        kind,
        builtIn,
        maturity: builtIn ? 'test' : (maturity.get(kind) ?? 'test'),
        ...(builtIn ? { typed: 'production' as const } : {}),
        descriptors: entries
          .filter((e) => e.operation === kind)
          .map((e) => ({ id: e.id, status: e.status, protocol: e.protocol ?? '' })),
      };
    });
  };

  const tryIt = (id: string, b: Record<string, unknown>) => {
    if (environment !== 'test')
      return problem(403, [{ path: 'environment', message: 'GENAI_ENV is not test' }]);
    const entry = entries.find((e) => e.id === id);
    if (!entry) return problem(404, [{ path: 'id', message: `no descriptor ${id}` }]);
    const model = models().find((m) => m.id === b.model);
    if (!model) return problem(404, [{ path: 'model', message: `no model ${String(b.model)}` }]);
    if (!(model.operations ?? ['chat']).includes(entry.operation))
      return problem(400, [
        {
          path: 'unsupported',
          message: `${model.id} does not list the ${entry.operation} operation`,
        },
      ]);
    const input = maskAll(b.input) as Record<string, unknown>;
    const task = `t-try-${tries.size + 2}`;
    const image = entry.operation === 'generate-image';
    const raw = image
      ? { data: [{ b64_json: pixel }], usage: { input_tokens: 12, output_tokens: 0 } }
      : { label: 'billing', usage: { input_tokens: 9 } };
    const exchange: WireExchange = {
      deployment: model.deployment,
      input,
      request: {
        method: 'POST',
        path: image ? '/images/generations' : '/classifications',
        body: { model: model.deployment, ...input },
      },
      response: { status: 200, body: raw },
      result: image ? { images: [pixel] } : { label: 'billing' },
      usage: image ? { inputTokens: 12, requests: 1 } : { inputTokens: 9, requests: 1 },
      dropped: 0,
    };
    tries.set(task, { id, exchange: JSON.stringify(exchange) });
    const result = image
      ? {
          images: [
            {
              kind: 'media',
              mediaType: 'image/png',
              bytes: 68,
              sha256: 'mock',
              tenant: '991825827',
              path: `runs/${task}/media/1`,
            },
          ],
        }
      : { label: 'billing' };
    return json({ task, descriptor: id, model: model.id, result, exchange });
  };

  const upload = (id: string, b: Record<string, unknown>) => {
    const before = entries.find((e) => e.id === id);
    if (before?.source === 'bundled')
      return problem(409, [
        { path: 'id', message: `${id} is bundled with Genki; upload a new version instead` },
      ]);
    if (before?.status === 'described')
      return problem(409, [
        {
          path: 'id',
          message: `${id} is described and may be in use; upload a new version instead`,
        },
      ]);
    let doc: unknown;
    try {
      doc = typeof b.descriptor === 'string' ? parseYaml(b.descriptor) : b.descriptor;
    } catch (error) {
      return problem(422, [{ path: 'descriptor', message: String(error) }]);
    }
    if (!doc || typeof doc !== 'object')
      return problem(422, [{ path: 'descriptor', message: 'a descriptor is a mapping of fields' }]);
    const d = doc as Record<string, unknown>;
    const errors = [
      ...(d.id === id ? [] : [{ path: 'id', message: `the descriptor is called ${String(d.id)}` }]),
      ...(typeof d.operation === 'string'
        ? []
        : [{ path: 'descriptor', message: `${id}: operation: missing` }]),
    ];
    if (errors.length) return problem(422, errors);
    const fixtureCases = (Array.isArray(b.fixtures) ? b.fixtures : []) as DescriptorFixture[];
    const entry: Entry = {
      id,
      operation: String(d.operation),
      status: 'review',
      source: 'uploaded',
      summary: typeof d.summary === 'string' ? d.summary : '',
      protocol: 'openai-chat',
      fixtures: fixtureCases.length,
      contract: passed(fixtureCases.length),
      input: before?.input ?? { kind: 'object', fields: { text: { kind: 'text' } } },
      usedBy: [],
      version: (before?.version ?? 0) + 1,
      by: 'operator:entra:lise',
      at: new Date().toISOString(),
      document: { ...d, status: 'review' },
      fixtureCases,
    };
    entries = before ? entries.map((e) => (e.id === id ? entry : e)) : [...entries, entry];
    return json({ ...view(entry), step: before ? 'replaced' : 'uploaded' }, before ? 200 : 201);
  };

  const recordFixture = (id: string, b: Record<string, unknown>) => {
    if (environment !== 'test')
      return problem(403, [
        { path: 'environment', message: 'fixtures are recorded from tries, in test only' },
      ]);
    const entry = entries.find((e) => e.id === id);
    if (!entry) return problem(404, [{ path: 'id', message: `no descriptor ${id}` }]);
    if (entry.source === 'bundled' || entry.status !== 'review')
      return problem(409, [{ path: 'id', message: `${id} takes no recorded fixture` }]);
    const tried = tries.get(String(b.task));
    if (!tried || tried.id !== id)
      return problem(422, [
        { path: 'task', message: `${String(b.task)} is not a finished try of ${id}` },
      ]);
    if (tried.exchange !== JSON.stringify(b.exchange))
      return problem(422, [
        { path: 'exchange', message: 'the exchange is not the one this try sent and received' },
      ]);
    const name = String(b.name);
    if ((entry.fixtureCases ?? []).some((f) => f.name === name))
      return problem(422, [
        { path: 'name', message: `${id} already has a fixture called ${name}` },
      ]);
    const exchange = b.exchange as WireExchange;
    const fixtureCases = [
      ...(entry.fixtureCases ?? []),
      { name, source: `recorded from the synthetic try ${String(b.task)}`, input: exchange.input },
    ];
    const next: Entry = {
      ...entry,
      fixtureCases,
      fixtures: fixtureCases.length,
      contract: passed(fixtureCases.length),
      version: (entry.version ?? 0) + 1,
      at: new Date().toISOString(),
    };
    entries = entries.map((e) => (e.id === id ? next : e));
    return json({ ...view(next), step: 'fixture-recorded' }, 201);
  };

  const setStatus = (id: string, b: Record<string, unknown>) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return problem(404, [{ path: 'id', message: `no descriptor ${id}` }]);
    if (entry.source === 'bundled')
      return problem(409, [{ path: 'id', message: `${id} is bundled with Genki` }]);
    const status = b.status === 'described' ? 'described' : b.status === 'review' ? 'review' : null;
    if (!status)
      return problem(400, [{ path: 'status', message: 'status is review or described' }]);
    if (status === 'described' && !entry.contract?.passed)
      return problem(422, [
        {
          path: 'fixtures',
          message: `${id} has no fixtures yet; record one from a try before it is described`,
        },
      ]);
    const next: Entry = { ...entry, status, at: new Date().toISOString() };
    entries = entries.map((e) => (e.id === id ? next : e));
    return json({ ...view(next), step: status === 'described' ? 'described' : 'back-to-review' });
  };

  const processorView = (endpoint: string): EndpointProcessorRecord => ({
    endpoint,
    record: records.get(endpoint) ?? null,
  });

  return (
    path: string,
    method: string,
    reason: string | null,
    body: () => Record<string, unknown>,
  ): Response | undefined => {
    if (path === '/operator/operation-kinds' && method === 'GET')
      return json({ environment, governs: 'descriptor-calls', data: kinds() });
    const kind = /^\/operator\/operation-kinds\/([^/]+)\/maturity$/.exec(path);
    if (kind && method === 'POST') {
      if (!reason) return problem(400, [{ path: 'change-reason', message: 'missing' }]);
      const k = decodeURIComponent(kind[1] ?? '');
      const to = body().maturity === 'production' ? 'production' : 'test';
      maturity.set(k, to);
      return json({ ...kinds().find((x) => x.kind === k), step: 'promoted' });
    }
    if (path === '/operator/operation-descriptors' && method === 'GET')
      return json({ data: entries.map(view).sort((a, b) => a.id.localeCompare(b.id)) });
    const tried = /^\/operator\/operations\/(.+)\/try$/.exec(path);
    if (tried && method === 'POST') {
      if (!reason) return problem(400, [{ path: 'change-reason', message: 'missing' }]);
      return tryIt(tried[1] ?? '', body());
    }
    const descriptor = /^\/operator\/operation-descriptors\/(.+?)(\/status|\/fixtures)?$/.exec(
      path,
    );
    if (descriptor) {
      const id = descriptor[1] ?? '';
      const action = descriptor[2];
      if (method === 'GET' && !action) {
        const entry = entries.find((e) => e.id === id);
        return entry ? json(entry) : problem(404, [{ path: 'id', message: `no descriptor ${id}` }]);
      }
      if (!reason) return problem(400, [{ path: 'change-reason', message: 'missing' }]);
      if (method === 'PUT' && !action) return upload(id, body());
      if (method === 'POST' && action === '/status') return setStatus(id, body());
      if (method === 'POST' && action === '/fixtures') return recordFixture(id, body());
      if (method === 'DELETE' && !action) {
        const entry = entries.find((e) => e.id === id);
        if (!entry) return problem(404, [{ path: 'id', message: `no descriptor ${id}` }]);
        if (entry.source === 'bundled')
          return problem(409, [{ path: 'id', message: `${id} is bundled with Genki` }]);
        entries = entries.filter((e) => e.id !== id);
        return new Response(null, { status: 204 });
      }
    }
    if (path === '/operator/processor-records' && method === 'GET') {
      const endpoints = new Set([...models().map((m) => m.endpoint), ...records.keys()]);
      return json({ data: [...endpoints].sort().map(processorView) });
    }
    const processor = /^\/operator\/model-endpoints\/([^/]+)\/processor-record$/.exec(path);
    if (processor) {
      const endpoint = decodeURIComponent(processor[1] ?? '');
      if (method === 'GET')
        return records.has(endpoint)
          ? json(processorView(endpoint))
          : problem(404, [{ path: 'id', message: `${endpoint} has no processor record` }]);
      if (!reason) return problem(400, [{ path: 'change-reason', message: 'missing' }]);
      if (method === 'PUT') {
        const b = body() as unknown as ProcessorRecord;
        if (!b.agreement?.trim())
          return problem(400, [{ path: 'agreement', message: 'Too small: expected string' }]);
        records.set(endpoint, b);
        return json(processorView(endpoint));
      }
      if (method === 'DELETE') {
        records.delete(endpoint);
        return new Response(null, { status: 204 });
      }
    }
    return undefined;
  };
};
