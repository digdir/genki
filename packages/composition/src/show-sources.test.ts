import { describe, expect, it } from 'vitest';
import type { Part, Principal } from '@genai/contracts';
import { platformSettings, SettingsRegistry } from '@genai/definitions';
import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import { checkOverrides, withSourcesSetting } from './settings-runtime.js';

const tenant = '991825827';
const person: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };
const ctx = {
  principal: person,
  tenant,
  capability: { id: 'veileder', version: '1' },
} as unknown as InvocationContext;
const config = (settings: Record<string, unknown> = {}) => ({
  settings,
  model: { primary: 'gpt', tenant },
});

const answer: Part[] = [
  {
    mime: 'text/plain',
    body: { kind: 'text', text: 'Du kan søke om tilskudd [1] innen fristen [2].' },
    meta: {
      citations: [
        { index: 1, chunkId: 'a' },
        { index: 2, chunkId: 'b' },
      ],
    },
  },
  {
    mime: 'application/vnd.genai.sources+json',
    body: {
      kind: 'json',
      json: { sources: [{ id: 'a', title: 'Tilskudd' }], insufficient: false },
    },
  },
];

const answering: Strategy = {
  id: 'fake',
  version: '1',
  requires: { kernel: 1, ports: [], features: [] },
  run: async function* () {
    yield { type: 'kernel.part.delta', data: { text: 'Du kan' } };
    yield { type: 'kernel.result', data: structuredClone(answer) };
  },
};

const resultOf = async (registry: SettingsRegistry, settings: Record<string, unknown> = {}) => {
  const events: Emitted[] = [];
  for await (const event of withSourcesSetting(registry, answering).run(
    ctx,
    { data: { question: 'Kan jeg søke?' } },
    config(settings),
  ))
    events.push(event);
  return events.find((e) => e.type === 'kernel.result')?.data as Part[];
};

describe('sources in answers', () => {
  it('gives the answer with its sources unless the setting is turned off', async () => {
    expect(await resultOf(new SettingsRegistry(platformSettings))).toEqual(answer);
  });

  it('leaves out the sources and the source markers when the organisation turns sources off', async () => {
    const registry = new SettingsRegistry(platformSettings);
    registry.setTenant(tenant, 'answers.showSources', false);

    const [text, sources] = await resultOf(registry);

    expect(text?.body).toEqual({ kind: 'text', text: 'Du kan søke om tilskudd innen fristen.' });
    expect(text?.meta?.citations).toEqual([]);
    expect(sources?.body).toEqual({ kind: 'json', json: { sources: [], insufficient: false } });
  });

  it('leaves the same source markers out of the streamed text as out of the answer, also when a marker is split across pieces', async () => {
    const registry = new SettingsRegistry(platformSettings);
    registry.setTenant(tenant, 'answers.showSources', false);
    const streaming: Strategy = {
      ...answering,
      run: async function* () {
        for (const text of ['Du kan søke om tilskudd [', '1] innen', ' fristen [2', '].'])
          yield { type: 'kernel.part.delta', data: { text } };
        yield { type: 'kernel.result', data: structuredClone(answer) };
      },
    };

    const events: Emitted[] = [];
    for await (const event of withSourcesSetting(registry, streaming).run(
      ctx,
      { data: { question: 'Kan jeg søke?' } },
      config(),
    ))
      events.push(event);
    const streamed = events
      .filter((e) => e.type === 'kernel.part.delta')
      .map((e) => (e.data as { text: string }).text)
      .join('');

    const result = events.find((e) => e.type === 'kernel.result')?.data as Part[];
    expect(streamed).toBe('Du kan søke om tilskudd innen fristen.');
    expect(result[0]?.body).toEqual({ kind: 'text', text: streamed });
  });

  it('lets a service turn sources back on when the organisation has turned them off', async () => {
    const registry = new SettingsRegistry(platformSettings);
    registry.setTenant(tenant, 'answers.showSources', false);

    expect(await resultOf(registry, { 'answers.showSources': true })).toEqual(answer);
  });

  it('refuses the sources setting on a single call', () => {
    const checked = checkOverrides(new SettingsRegistry(platformSettings), person, {
      'answers.showSources': false,
    });

    expect(checked.ok).toBe(false);
  });
});
