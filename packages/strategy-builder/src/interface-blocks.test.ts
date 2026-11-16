import { describe, expect, it } from 'vitest';
import type { PluginSchemas } from '@genai/definitions';
import type { ChatRequest, ChatResult, ModelPort } from '@genai/port-model';
import { describedBlocks } from '@genai/ui-blocks/builder';
import { runTurn, type BuilderTurnInput, type InterfaceBlock } from './index.js';

const tenant = '991825827';

const plugins: PluginSchemas = {
  strategies: new Map(),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  models: new Map([['norsk-modell', { residency: 'norway' as const, capabilities: ['tools'] }]]),
};

const input = (message: string, overrides: Partial<BuilderTurnInput> = {}): BuilderTurnInput => ({
  target: 'service',
  tenant,
  message,
  intent: 'chat',
  draft: {
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant, id: 'kunnskapsassistenten', name: 'Kunnskapsassistenten' },
    spec: { purpose: 'Svar med kilder fra offentlige rapporter' },
  },
  model: 'norsk-modell',
  systemPrompt: 'Du er byggeassistenten.',
  stream: false,
  context: {
    available: [],
    refused: [],
    blockedResidencies: [],
    interfaceBlocks: describedBlocks(),
  },
  ...overrides,
});

const catalogueIn = (request: ChatRequest): InterfaceBlock[] => {
  const system = request.messages[0]?.content ?? '';
  const found = /kind="interface-blocks">\n([\s\S]*?)\n<\/untrusted_data>/.exec(system)?.[1];
  return found ? (JSON.parse(found) as InterfaceBlock[]) : [];
};

const words = (text: string) => text.toLowerCase().match(/[\p{L}]{4,}/gu) ?? [];

// Stands in for the model: picks the block whose covered needs share the most words with the user's.
const matching = (pick: (request: ChatRequest) => string[] = () => []) => {
  const seen: ChatRequest[] = [];
  const reply = (result: Partial<ChatResult>): ChatResult => ({
    content: result.content ?? '',
    toolCalls: result.toolCalls ?? [],
    finishReason: result.toolCalls?.length ? 'tool_calls' : 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
    servedModel: 'norsk-modell',
  });
  const model: ModelPort = {
    info: () => ({ id: 'norsk-modell', residency: 'norway', capabilities: ['tools'] }),
    chat: async (request) => {
      seen.push(structuredClone(request));
      if (seen.length > 1) return reply({ content: 'Ferdig.' });
      const asked = new Set(words(String(request.messages.at(-1)?.content ?? '')));
      const scored = catalogueIn(request)
        .map((block) => ({
          id: block.id,
          score: block.covers
            .flatMap((cover) => [...words(cover.nb), ...words(cover.en)])
            .filter((word) => asked.has(word)).length,
        }))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      const blocks = pick(request);
      if (blocks.length === 0 && (!best || best.score === 0)) return reply({ content: 'Usikker.' });
      return reply({
        toolCalls: [
          {
            id: 'c1',
            name: 'choose_interface_blocks',
            arguments: JSON.stringify({
              title: 'Legg til klosser',
              blocks: blocks.length > 0 ? blocks : [best?.id],
            }),
          },
        ],
      });
    },
    chatStream: async function* () {
      yield* [];
      throw new Error('not streamed');
    },
  };
  return { model, seen };
};

const run = async (turn: BuilderTurnInput, model: ModelPort) => {
  const generator = runTurn({ input: turn, plugins, ports: { model }, newId: () => 'p1' });
  for (;;) {
    const next = await generator.next();
    if (next.done) return next.value;
  }
};

describe('the builder assistant choosing interface blocks', () => {
  it('a need for easy access to the original document picks the document view', async () => {
    const { model } = matching();

    const result = await run(input('Leserne må ha enkel tilgang til originaldokumentet'), model);

    expect(result.rejected).toBeUndefined();
    expect(result.proposals).toEqual([
      expect.objectContaining({
        level: 1,
        kind: 'interface',
        blocks: ['document-view'],
        validation: { ok: true },
        appliedToDraft: false,
      }),
    ]);
  });

  it('gives the model each block with the needs it covers, and the tool to choose them', async () => {
    const { model, seen } = matching();

    await run(input('Hei'), model);

    expect(catalogueIn(seen[0] as ChatRequest)).toEqual(describedBlocks());
    expect(seen[0]?.tools?.map((tool) => tool.name)).toContain('choose_interface_blocks');
  });

  it('offers no interface tool when the host sends no blocks', async () => {
    const { model, seen } = matching();
    const without = input('Hei');
    Reflect.deleteProperty(without.context, 'interfaceBlocks');

    await run(without, model);

    expect(seen[0]?.tools?.map((tool) => tool.name)).not.toContain('choose_interface_blocks');
  });

  it('refuses a block that is not in the catalogue, and proposes nothing', async () => {
    const { model } = matching(() => ['document-view', 'map']);

    const result = await run(input('Vis et kart'), model);

    expect(result.proposals).toEqual([]);
    expect(result.rejected?.[0]).toMatchObject({ code: 'VALIDATION_UNKNOWN_REFERENCE' });
    expect(result.rejected?.[0]?.reason).toContain('map');
  });
});
