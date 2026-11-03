import { describe, expect, it } from 'vitest';
import type { Principal, Usage } from '@genai/contracts';
import {
  createGate,
  createKernel,
  GateError,
  InMemoryEventLog,
  type GateChunk,
  type GatePayload,
  type GateRecord,
  type GateTarget,
  type InvocationContext,
  type Masker,
  type PayloadGuard,
  type PortContext,
  type PortProvider,
} from './index.js';
import {
  gateContract,
  syntheticNationalId,
  type GateContractSubject,
  type GateLane,
  type GateLaneSetup,
  type Smuggled,
} from './gate-contract.js';
import { array, number, object, optional, ref, text } from './payload.js';

const tenant = '999888777';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };

const tokenMasker = (): Masker => {
  const values = new Map<string, string>();
  return {
    mask: (text) =>
      text.replace(/\b\d{11}\b/g, (value) => {
        const token = `«ID_${values.size + 1}»`;
        values.set(token, value);
        return token;
      }),
    unmask: (text) => text.replace(/«ID_\d+»/g, (token) => values.get(token) ?? token),
    pending: (text) => {
      const open = text.lastIndexOf('«');
      return open >= 0 && !text.includes('»', open) ? text.length - open : 0;
    },
  };
};

const chat: GatePayload<string> = {
  shape: { request: object({ messages: array(text) }), result: text },
  usage: () => ({ inputTokens: 2, requests: 1 }),
};

const laneChat: GatePayload<Answer> = {
  shape: {
    request: object({ messages: array(text), user: optional(ref()) }),
    result: object({ content: text }),
  },
  usage: () => ({ inputTokens: 2, requests: 1 }),
};

const laneEmbed: GatePayload<Answer> = {
  shape: { request: array(text), result: object({ vectors: array(array(number())) }) },
  usage: () => ({ inputTokens: 2, requests: 1 }),
};

const laneRerank: GatePayload<Answer> = {
  shape: {
    request: object({ query: text, documents: array(text) }),
    result: object({ ranking: array(number()) }),
  },
  usage: () => ({ requests: 1 }),
};

const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };

const contextFor = (setup: GateLaneSetup, metered: Usage[], audit: GateRecord[]): PortContext => ({
  tenant,
  principal: kari,
  task: 't1',
  signal: new AbortController().signal,
  meter: async (usage) => {
    metered.push(usage);
  },
  audit: async (record) => {
    audit.push(record);
  },
  ...(setup.guards ? { guards: setup.guards } : {}),
  ...(setup.serviceResidency ? { serviceResidency: setup.serviceResidency } : {}),
});

const targetFor = (
  setup: GateLaneSetup,
  port: string,
  operation: string,
  admission: GateTarget['admission'],
): GateTarget => ({
  port,
  operation,
  model: { kind: port, id: `${port}/fake` },
  endpoint: 'fake',
  residency: setup.residency ?? 'norway',
  admission,
  ...(setup.enabled === undefined ? {} : { enabled: setup.enabled }),
  ...(setup.sharedWith ? { tenants: setup.sharedWith } : {}),
  ...(setup.routerResidency ? { routerResidency: setup.routerResidency } : {}),
  ...(setup.requestResidency ? { requestResidency: setup.requestResidency } : {}),
});

type Answer = Record<string, unknown>;

const lane = <Req>(
  port: string,
  operation: string,
  admission: GateTarget['admission'],
  payload: GatePayload<Answer>,
  request: (text: string, extra: { media?: boolean; smuggle?: Smuggled }) => Req,
  sent: (request: Req) => string[],
  answer: (request: Req) => Answer,
  text?: (result: Answer) => string,
): GateLane => ({
  port,
  operation,
  admission,
  tenant,
  has: { enabled: true, sharing: true, routerResidency: true, requestResidency: true },
  answersWithText: text !== undefined,
  refusalOf: (error) => (error instanceof GateError ? error.refusal : undefined),
  open: (setup) => {
    const upstream: string[] = [];
    const metered: Usage[] = [];
    const audit: GateRecord[] = [];
    const gate = createGate({ admits: () => setup.admitted ?? true });
    const send = (r: Req) => {
      upstream.push(...sent(r));
      if (setup.failUpstream) throw new Error('the provider is down');
      return setup.unknownAnswerField ? { ...answer(r), surprise: 1 } : answer(r);
    };
    return {
      upstream,
      metered,
      audit,
      call: async (input, extra = {}) => {
        const result = await gate.call(
          contextFor(setup, metered, audit),
          targetFor(setup, port, operation, admission),
          payload,
          request(input, extra),
          async (r) => send(r),
        );
        return text?.(result);
      },
      ...(text
        ? {
            stream: async (input: string) => {
              let out = '';
              for await (const chunk of gate.stream(
                contextFor(setup, metered, audit),
                targetFor(setup, port, operation, admission),
                payload,
                request(input, {}),
                async function* (r) {
                  const result = send(r);
                  yield { kind: 'delta', text: text(result) };
                  if (setup.unknownStreamEvent)
                    yield { kind: 'tool-call', text: '' } as unknown as GateChunk<Answer>;
                  yield { kind: 'done', result };
                },
              ))
                if (chunk.kind === 'delta') out += chunk.text;
              return out;
            },
          }
        : {}),
    };
  },
});

const smuggled = (smuggle: Smuggled | undefined) =>
  smuggle === 'field'
    ? { previous_response_id: 'resp_1' }
    : smuggle === 'url'
      ? { user: 'https://evil.example/file' }
      : smuggle === 'object-id'
        ? { user: 'file-abc123' }
        : {};

const subject: GateContractSubject = {
  lanes: [
    lane(
      'model',
      'chat',
      'admitted',
      laneChat,
      (text, { media, smuggle }) => ({
        messages: media ? [text, [image]] : [text],
        ...smuggled(smuggle),
      }),
      (r) => r.messages.filter((m): m is string => typeof m === 'string'),
      (r) => ({ content: String(r.messages[0]) }),
      (result) => String(result.content),
    ),
    lane(
      'embedding',
      'embed',
      'open',
      laneEmbed,
      (text, { media, smuggle }) =>
        smuggle === 'field'
          ? [text, 42]
          : smuggle
            ? [text, smuggle === 'url' ? { url: 'https://evil.example' } : { file_id: 'file-1' }]
            : media
              ? [text, image]
              : [text],
      (texts) => texts.filter((t): t is string => typeof t === 'string'),
      (texts) => ({ vectors: texts.map(() => [0.1]) }),
    ),
    lane(
      'rerank',
      'rerank',
      'admitted',
      laneRerank,
      (text, { media, smuggle }) => ({
        query: media ? image : smuggle === 'url' ? { url: 'https://evil.example' } : text,
        documents: smuggle === 'object-id' ? [{ file_id: 'file-1' }] : [text],
        ...(smuggle === 'field' ? { model: 'other' } : {}),
      }),
      (r) => [
        ...(typeof r.query === 'string' ? [r.query] : []),
        ...r.documents.filter((d): d is string => typeof d === 'string'),
      ],
      () => ({ ranking: [0] }),
    ),
  ],
  nationalIdGuard: () => ({ masker: tokenMasker() }),
};

describe(`${gateContract.contract} contract: the bare gate`, () => {
  for (const check of gateContract.checks)
    it(check.name, async () => {
      await check.run(subject, new AbortController().signal);
    });
});

const streamed = async (
  guards: PayloadGuard[],
  chunks: GateChunk<string>[],
): Promise<{ out: GateChunk<string>[]; order: string[] }> => {
  const order: string[] = [];
  const gate = createGate();
  const ctx = contextFor({ guards }, [], []);
  const out: GateChunk<string>[] = [];
  const target = targetFor({}, 'model', 'chat', 'admitted');
  for await (const chunk of gate.stream(
    ctx,
    target,
    chat,
    { messages: ['hei'] },
    async function* () {
      for (const c of chunks) {
        order.push(`upstream:${c.kind}`);
        yield c;
      }
    },
  ))
    out.push(chunk);
  return { out, order };
};

describe('the gate', () => {
  it('restores a masked value even when the stream splits its token across chunks', async () => {
    const masker = tokenMasker();
    masker.mask(syntheticNationalId);
    const { out } = await streamed(
      [{ masker }],
      [
        { kind: 'delta', text: 'Gjelder «I' },
        { kind: 'delta', text: 'D_1» og ' },
        { kind: 'delta', text: 'ingen andre.' },
        { kind: 'done', result: 'Gjelder «ID_1» og ingen andre.' },
      ],
    );
    expect(out.flatMap((c) => (c.kind === 'delta' ? [c.text] : [])).join('')).toBe(
      `Gjelder ${syntheticNationalId} og ingen andre.`,
    );
    expect(out.at(-1)).toEqual({
      kind: 'done',
      result: `Gjelder ${syntheticNationalId} og ingen andre.`,
    });
  });

  it('holds streamed text until a guard that holds the stream has seen the result', async () => {
    const seen: string[] = [];
    const guard: PayloadGuard = {
      holdsStream: true,
      result: () => {
        seen.push('guard');
      },
    };
    const { out } = await streamed(
      [guard],
      [
        { kind: 'delta', text: 'svar' },
        { kind: 'done', result: 'svar' },
      ],
    );
    expect(seen).toEqual(['guard']);
    expect(out.map((c) => c.kind)).toEqual(['delta', 'done']);
  });

  it('masks before any guard sees the request and restores after every guard has seen the result', async () => {
    const masker = tokenMasker();
    const seen: unknown[] = [];
    const guard: PayloadGuard = {
      masker,
      request: (_call, body) => {
        seen.push(body);
        return body;
      },
    };
    const watcher: PayloadGuard = {
      request: (_call, body) => {
        seen.push(body);
        return body;
      },
      result: (_call, body) => {
        seen.push(body);
      },
    };
    const gate = createGate();
    const answer = await gate.call(
      contextFor({ guards: [guard, watcher] }, [], []),
      targetFor({}, 'model', 'chat', 'admitted'),
      chat,
      { messages: [`fnr ${syntheticNationalId}`] },
      async (r) => String(r.messages[0]),
    );
    expect(seen).toEqual([
      { messages: ['fnr «ID_1»'] },
      { messages: ['fnr «ID_1»'] },
      'fnr «ID_1»',
    ]);
    expect(answer).toBe(`fnr ${syntheticNationalId}`);
  });

  it('a guard that refuses the request stops the call and is audited as refused', async () => {
    const audit: GateRecord[] = [];
    let called = false;
    const guard: PayloadGuard = {
      request: () => {
        throw new Error('stopped by a hook');
      },
    };
    await expect(
      createGate().call(
        contextFor({ guards: [guard] }, [], audit),
        targetFor({}, 'model', 'chat', 'admitted'),
        chat,
        { messages: ['hei'] },
        async () => {
          called = true;
          return 'svar';
        },
      ),
    ).rejects.toThrow('stopped by a hook');
    expect(called).toBe(false);
    expect(audit).toMatchObject([{ outcome: 'refused', refusal: 'guard' }]);
  });

  it('turns a refusal into the error the port gives', async () => {
    const target: GateTarget = {
      ...targetFor({ residency: 'global' }, 'model', 'chat', 'admitted'),
      refuse: (refusal, message) => Object.assign(new Error(message), { code: refusal }),
    };
    await expect(
      createGate().call(
        contextFor({ serviceResidency: 'eu' }, [], []),
        target,
        chat,
        { messages: ['hei'] },
        async () => 'svar',
      ),
    ).rejects.toMatchObject({ code: 'residency', message: 'model model/fake runs outside eu' });
  });
});

describe('the bar before real data', () => {
  const described = (extra: Partial<GateTarget>): GateTarget => ({
    ...targetFor({}, 'described', 'classify', 'admitted'),
    ...extra,
  });
  const attempt = async (tier: 'test' | 'production', target: GateTarget, request: unknown) => {
    const audit: GateRecord[] = [];
    let sent = false;
    const outcome = await createGate({ tier })
      .call(contextFor({}, [], audit), target, chat, request, async () => {
        sent = true;
        return 'svar';
      })
      .then(
        () => 'ok',
        (error: unknown) => (error instanceof GateError ? error.refusal : 'failed'),
      );
    return { outcome, sent, audit };
  };
  const hei = { messages: ['hei'] };

  it('a kind in test serves only synthetic calls in a test environment', async () => {
    const inTest = described({ maturity: 'test', processorRecord: true });
    expect((await attempt('test', { ...inTest, synthetic: true }, hei)).outcome).toBe('ok');
    const real = await attempt('test', inTest, hei);
    expect(real).toMatchObject({ outcome: 'maturity', sent: false });
    expect(real.audit).toMatchObject([{ outcome: 'refused', refusal: 'maturity' }]);
    expect((await attempt('production', { ...inTest, synthetic: true }, hei)).outcome).toBe(
      'maturity',
    );
    const ready = described({ maturity: 'production', processorRecord: true });
    expect((await attempt('production', ready, hei)).outcome).toBe('ok');
  });

  it('an endpoint without a processor record cannot carry real data, and a synthetic call needs none', async () => {
    const bare = described({ maturity: 'production', processorRecord: false });
    expect(await attempt('production', bare, hei)).toMatchObject({
      outcome: 'processor',
      sent: false,
    });
    expect((await attempt('test', { ...bare, synthetic: true }, hei)).outcome).toBe('ok');
  });

  it('media passes only to a target whose endpoint records acceptsUnmaskedInput', async () => {
    const image = {
      messages: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    };
    const ready = described({ maturity: 'production', processorRecord: true });
    expect(await attempt('production', ready, image)).toMatchObject({
      outcome: 'media',
      sent: false,
    });
    expect((await attempt('production', { ...ready, unmaskedInput: true }, image)).outcome).toBe(
      'ok',
    );
  });
});

describe('use', () => {
  it('hands the guards and the service residency to the port and writes kernel.gate.call to the audit log', async () => {
    const guard: PayloadGuard = { masker: tokenMasker() };
    const opened: PortContext[] = [];
    const provider: PortProvider<{ ask(text: string): Promise<string> }> = {
      open: (_ref, ctx) => {
        opened.push(ctx);
        return {
          ask: (text) =>
            createGate().call(
              ctx,
              targetFor({}, 'model', 'chat', 'admitted'),
              chat,
              { messages: [text] },
              async (r) => String(r.messages[0]),
            ),
        };
      },
    };
    const log = new InMemoryEventLog();
    const kernel = createKernel({
      strategies: [
        {
          id: 'asking',
          version: '1',
          requires: { kernel: 1, ports: ['model'], features: [] },
          run: async function* (ctx: InvocationContext) {
            const model = await ctx.use<{ ask(text: string): Promise<string> }>(
              'model',
              { kind: 'model', id: 'm', tenant },
              { guards: [guard], serviceResidency: 'eu' },
            );
            yield {
              type: 'kernel.result',
              data: [
                {
                  mime: 'text/plain',
                  body: { kind: 'text', text: await model.ask(syntheticNationalId) },
                },
              ],
            };
          },
        },
      ],
      capabilities: [
        {
          descriptor: {
            id: 'svc',
            version: '1',
            tenant,
            title: 'svc',
            description: 'svc',
            input: {},
            interaction: ['unary'],
            accepts: ['text/plain'],
            produces: ['text/plain'],
            emits: [],
            oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI' },
          },
          strategy: { id: 'asking', version: '1' },
          config: {},
          grants: [{ port: 'model', ref: { kind: 'model', id: 'm', tenant } }],
        },
      ],
      ports: { model: provider },
      policy: { decide: async () => ({ allow: true }) },
      log,
    });
    const run = await kernel.invoke(kari, 'svc', { data: {} });
    await run.result;
    expect(opened[0]).toMatchObject({ guards: [guard], serviceResidency: 'eu' });
    const audit = [];
    for await (const e of await kernel.events(kari, run.task, { audience: 'audit' }))
      if (e.type === 'kernel.gate.call') audit.push(e.data);
    expect(audit).toEqual([
      {
        port: 'model',
        operation: 'chat',
        model: 'model/fake',
        endpoint: 'fake',
        residency: 'norway',
        outcome: 'ok',
        usage: { inputTokens: 2, requests: 1 },
      },
    ]);
  });
});

describe('the gate outside a run', () => {
  it('audits and meters a call outside a run through the outside sink, and leaves a run to its own audit', async () => {
    const outside: { audit: GateRecord[]; metered: Usage[] } = { audit: [], metered: [] };
    const gate = createGate({
      outside: {
        audit: async (_ctx, record) => {
          outside.audit.push(record);
        },
        meter: async (_ctx, usage) => {
          outside.metered.push(usage);
        },
      },
    });
    const target = targetFor({}, 'embedding', 'embed', 'open');
    const payload = laneEmbed;
    const send = async () => ({ vectors: [[0.1]] });
    const noRun = contextFor({}, [], []);
    Reflect.deleteProperty(noRun, 'audit');
    await gate.call(noRun, target, payload, ['hei'], send);
    expect(outside.audit).toMatchObject([{ port: 'embedding', outcome: 'ok' }]);
    expect(outside.metered).toEqual([{ inputTokens: 2, requests: 1 }]);

    const inRun: GateRecord[] = [];
    await gate.call(contextFor({}, [], inRun), target, payload, ['hei'], send);
    expect(inRun).toHaveLength(1);
    expect(outside.audit).toHaveLength(1);
  });

  it("hands adapters a fetch that applies the endpoint's egress guard on every request", async () => {
    const reached: string[] = [];
    let allowed = false;
    const gate = createGate({
      egress: (endpoint) =>
        endpoint === 'plugin'
          ? ((async (input: string) => {
              if (!allowed) throw new Error('egress refused');
              reached.push(input);
              return new Response('ok');
            }) as unknown as typeof fetch)
          : undefined,
    });
    const fetch = gate.egress('plugin');
    await expect(fetch('https://plugin.example/a')).rejects.toThrow('egress refused');
    allowed = true;
    await fetch('https://plugin.example/b');
    expect(reached).toEqual(['https://plugin.example/b']);
  });
});
