import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Ref } from '@genai/contracts';
import { InMemoryDefinitionStore, strategyKey, type PluginSchemas } from '@genai/definitions';
import type { PortProvider } from '@genai/kernel';
import type { ChatRequest, ChatResult, ModelPort } from '@genai/port-model';
import { singleCallConfig } from '@genai/strategy-single-call';

export const examples = join(import.meta.dirname, '..', 'examples');
export const tenant = '991825827';
export const modelId = 'foundry-openai/gpt-4o-2m-tps';

export const readExample = (file: string) => readFileSync(join(examples, file), 'utf8');

export const promptFiles = () =>
  Object.fromEntries(
    readdirSync(join(examples, 'prompts')).map((f) => [
      `prompts/${f}`,
      readExample(`prompts/${f}`),
    ]),
  );

export const letters = () =>
  readdirSync(join(examples, 'letters')).map((f) => ({
    id: f.replace(/\.txt$/, ''),
    file: f,
    text: readExample(`letters/${f}`),
  }));

export const plugins: PluginSchemas = {
  strategies: new Map([[strategyKey('single-call', 1), singleCallConfig]]),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  models: new Map([
    [modelId, { residency: 'global', capabilities: ['stream', 'tools', 'json-schema'] }],
  ]),
};

export const publishedStore = async () => {
  const store = new InMemoryDefinitionStore(plugins);
  const files = promptFiles();
  const services: [string, string][] = [
    ['klarsprak.yaml', 'prompts/klarsprak.nb.md'],
    ['nynorsk.yaml', 'prompts/nynorsk.nn.md'],
  ];
  for (const [file, prompt] of services) {
    const result = await store.publish(parseYaml(readExample(file)), 'test', 'test', {
      [prompt]: files[prompt] ?? '',
    });
    if (!result.ok) throw new Error(`${file}: ${JSON.stringify(result.errors)}`);
  }
  return store;
};

export const fakeModels = (
  reply: (request: ChatRequest) => string,
): PortProvider<ModelPort> & { calls: ChatRequest[] } => {
  const calls: ChatRequest[] = [];
  return {
    calls,
    open: (ref: Ref) => ({
      info: () => ({ id: ref.id, residency: 'global', capabilities: ['tools', 'json-schema'] }),
      chat: async (request: ChatRequest): Promise<ChatResult> => {
        calls.push(request);
        return {
          content: reply(request),
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, requests: 1 },
          servedModel: 'gpt-4o-test',
        };
      },
      chatStream: async function* () {},
    }),
  };
};

export const lastUser = (request: ChatRequest) =>
  [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
