import type { Ref, Usage } from '@genai/contracts';
import { envSecrets, type PortContext } from '@genai/kernel';
import {
  check,
  checkEqual,
  checkFailsWith,
  fakeHttp,
  skipped,
  type ContractSuite,
  type ContractTarget,
  type FakeReply,
} from '@genai/plugins';
import type { ModelAdapter } from './adapter.js';
import { capabilities as allCapabilities, type Capability, type ModelPort } from './port.js';
import { ModelRouter } from './router.js';

export const modelContractVersion = 'model@1';

export type ModelScenario =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; arguments: string }
  | { kind: 'status'; status: number };

export interface ModelContractFixture {
  adapter: ModelAdapter;
  capabilities?: Capability[];
  basePath?: string;
  endpointOptions?: Record<string, unknown>;
  modelOptions?: Record<string, unknown>;
  reply(scenario: ModelScenario, body: Record<string, unknown>, path: string): FakeReply;
}

export interface ModelContractSubject {
  declared: Capability[];
  script?(scenario: ModelScenario): void;
  calls?(): number;
  open(
    capabilities: Capability[],
    signal?: AbortSignal,
  ): { port: ModelPort; metered: { usage: Usage; model?: Ref }[] };
}

export const modelContractTarget = async (
  fixture: ModelContractFixture,
): Promise<ContractTarget<ModelContractSubject>> => {
  let scenario: ModelScenario = { kind: 'text', text: 'Hei' };
  const server = await fakeHttp((body, _attempt, path) => fixture.reply(scenario, body, path));
  const subject: ModelContractSubject = {
    declared: fixture.capabilities ?? [...allCapabilities],
    script: (next) => {
      scenario = next;
    },
    calls: () => server.seen.length,
    open: (capabilities, signal = new AbortController().signal) => {
      const router = new ModelRouter({
        catalog: {
          endpoints: {
            contract: {
              protocol: fixture.adapter.protocol,
              baseURL: `${server.url}${fixture.basePath ?? ''}`,
              auth: { kind: 'bearer', secret: 'secret://env/contract-key' },
              options: fixture.endpointOptions ?? {},
            },
          },
          models: [
            {
              id: 'contract/model',
              endpoint: 'contract',
              deployment: 'contract-deployment',
              residency: 'norway',
              capabilities,
              options: fixture.modelOptions ?? {},
            },
          ],
        },
        adapters: [fixture.adapter],
        secrets: envSecrets({ CONTRACT_KEY: 'contract-key' }),
        maxRetries: 0,
        timeoutMs: 5000,
      });
      const metered: { usage: Usage; model?: Ref }[] = [];
      const ctx: PortContext = {
        tenant: '991825827',
        principal: { kind: 'employee', issuer: 'contract', subject: 'kari', tenant: '991825827' },
        task: 'contract',
        signal,
        meter: async (usage, model) => {
          metered.push({ usage, ...(model ? { model } : {}) });
        },
      };
      return { port: router.open({ kind: 'model', id: 'contract/model' }, ctx), metered };
    },
  };
  return { subject, close: () => server.close() };
};

const ask = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

const tool = {
  name: 'finn_sak',
  description: 'Finner en sak',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
};

const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _ of stream) void _;
};

export const modelContract: ContractSuite<ModelContractSubject> = {
  contract: modelContractVersion,
  checks: [
    {
      name: 'chat returns the text, usage and served model, and meters the usage once',
      run: async (s) => {
        s.script?.({ kind: 'text', text: 'Hei fra kontrakten' });
        const { port, metered } = s.open([]);
        const result = await port.chat(ask('Hei'));
        if (s.script) checkEqual(result.content, 'Hei fra kontrakten', 'content');
        else check(result.content.length > 0, 'the model answers');
        checkEqual(result.finishReason, 'stop', 'finish reason');
        checkEqual(result.toolCalls, [], 'tool calls');
        check(result.servedModel.length > 0, 'the served model is named');
        check((result.usage.inputTokens ?? 0) > 0, 'input tokens are counted');
        checkEqual(metered.length, 1, 'metered usage');
        checkEqual(metered[0]?.model, { kind: 'model', id: 'contract/model' }, 'metered model');
      },
    },
    {
      name: 'chatStream yields deltas that add up to the final result',
      run: async (s) => {
        if (!s.declared.includes('stream')) return skipped;
        s.script?.({ kind: 'text', text: 'Strømmet svar' });
        const { port, metered } = s.open(['stream']);
        let deltas = '';
        let final = '';
        let done = 0;
        for await (const chunk of port.chatStream(ask('Hei'))) {
          check(done === 0, 'nothing follows the done chunk');
          if (chunk.kind === 'delta') deltas += chunk.text;
          else {
            done += 1;
            final = chunk.result.content;
          }
        }
        checkEqual(done, 1, 'done chunks');
        checkEqual(deltas, final, 'joined deltas');
        if (s.script) checkEqual(final, 'Strømmet svar', 'streamed content');
        checkEqual(metered.length, 1, 'metered usage');
      },
    },
    {
      name: 'a declared tools capability returns the tool call with its arguments',
      run: async (s) => {
        if (!s.declared.includes('tools') || !s.script) return skipped;
        s.script({ kind: 'tool', id: 'call-1', name: 'finn_sak', arguments: '{"q":"tilskudd"}' });
        const { port } = s.open(['tools']);
        const result = await port.chat({ ...ask('Finn saken'), tools: [tool] });
        checkEqual(result.finishReason, 'tool_calls', 'finish reason');
        checkEqual(result.toolCalls.length, 1, 'tool calls');
        checkEqual(result.toolCalls[0]?.name, 'finn_sak', 'tool name');
        checkEqual(JSON.parse(result.toolCalls[0]?.arguments ?? '{}'), { q: 'tilskudd' }, 'args');
      },
    },
    {
      name: 'a declared json-schema capability returns content that parses',
      run: async (s) => {
        if (!s.declared.includes('json-schema') || !s.script) return skipped;
        s.script({ kind: 'text', text: '{"svar":"ja"}' });
        const { port } = s.open(['json-schema']);
        const result = await port.chat({
          ...ask('Svar ja'),
          jsonSchema: {
            name: 'svar',
            schema: {
              type: 'object',
              properties: { svar: { type: 'string' } },
              required: ['svar'],
              additionalProperties: false,
            },
          },
        });
        checkEqual(JSON.parse(result.content), { svar: 'ja' }, 'parsed content');
      },
    },
    {
      name: 'a capability the model does not declare fails as unsupported without calling upstream',
      run: async (s) => {
        const { port } = s.open([]);
        const before = s.calls?.();
        await checkFailsWith(
          () => port.chat({ ...ask('x'), tools: [tool] }),
          'unsupported',
          'tools',
        );
        await checkFailsWith(
          () => port.chat({ ...ask('x'), reasoning: 'low' }),
          'unsupported',
          'reasoning',
        );
        await checkFailsWith(() => drain(port.chatStream(ask('x'))), 'unsupported', 'stream');
        checkEqual(s.calls?.(), before, 'upstream calls');
      },
    },
    {
      name: 'upstream refusals map to rate_limited, unauthorized and unavailable',
      run: async (s) => {
        const script = s.script?.bind(s);
        if (!script) return skipped;
        const { port, metered } = s.open([]);
        for (const [status, code] of [
          [429, 'rate_limited'],
          [401, 'unauthorized'],
          [500, 'unavailable'],
        ] as const) {
          script({ kind: 'status', status });
          await checkFailsWith(() => port.chat(ask('x')), code, `HTTP ${status}`);
        }
        checkEqual(metered.length, 0, 'metered usage');
      },
    },
    {
      name: 'an aborted signal fails as cancelled',
      run: async (s) => {
        s.script?.({ kind: 'text', text: 'for sent' });
        const controller = new AbortController();
        controller.abort();
        const { port } = s.open([], controller.signal);
        await checkFailsWith(() => port.chat(ask('x')), 'cancelled', 'aborted chat');
      },
    },
  ],
};
