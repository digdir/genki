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
} from './gate-contract.js';

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

interface Chat {
  messages: unknown[];
}

const chat: GatePayload<Chat, string> = {
  contents: (r) => r.messages,
  mapRequest: (r, map) => ({
    messages: r.messages.map((m) => (typeof m === 'string' ? map(m) : m)),
  }),
  mapResult: (text, map) => map(text),
  usage: () => ({ inputTokens: 2, requests: 1 }),
};

const embed: GatePayload<unknown[], number[][]> = {
  contents: (texts) => texts,
  mapRequest: (texts, map) => texts.map((t) => (typeof t === 'string' ? map(t) : t)),
  mapResult: (vectors) => vectors,
  usage: () => ({ inputTokens: 2, requests: 1 }),
};

interface Rerank {
  query: unknown;
  documents: string[];
}

const rerank: GatePayload<Rerank, number[]> = {
  contents: (r) => [r.query, ...r.documents],
  mapRequest: (r, map) => ({
    query: typeof r.query === 'string' ? map(r.query) : r.query,
    documents: r.documents.map(map),
  }),
  mapResult: (ranking) => ranking,
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

const lane = <Req, Res>(
  port: string,
  operation: string,
  admission: GateTarget['admission'],
  payload: GatePayload<Req, Res>,
  request: (text: string, media: boolean) => Req,
  sent: (request: Req) => string[],
  answer: (request: Req) => Res,
  text?: (result: Res) => string,
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
    return {
      upstream,
      metered,
      audit,
      call: async (input, extra = {}) => {
        const result = await gate.call(
          contextFor(setup, metered, audit),
          targetFor(setup, port, operation, admission),
          payload,
          request(input, extra.media === true),
          async (r) => {
            upstream.push(...sent(r));
            if (setup.failUpstream) throw new Error('the provider is down');
            return answer(r);
          },
        );
        return text?.(result);
      },
    };
  },
});

const subject: GateContractSubject = {
  lanes: [
    lane(
      'model',
      'chat',
      'admitted',
      chat,
      (text, media) => ({ messages: media ? [text, [image]] : [text] }),
      (r) => r.messages.filter((m): m is string => typeof m === 'string'),
      (r) => String(r.messages[0]),
      (result) => result,
    ),
    lane(
      'embedding',
      'embed',
      'open',
      embed,
      (text, media) => (media ? [text, image] : [text]),
      (texts) => texts.filter((t): t is string => typeof t === 'string'),
      (texts) => texts.map(() => [0.1]),
    ),
    lane(
      'rerank',
      'rerank',
      'admitted',
      rerank,
      (text, media) => ({ query: media ? image : text, documents: [text] }),
      (r) => [...(typeof r.query === 'string' ? [r.query] : []), ...r.documents],
      () => [0],
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
