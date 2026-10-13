import { describe, expect, it } from 'vitest';
import type { ModelDescription } from '@genai/port-model';
import { modelDisplayNames, modelsForTenant } from './model-access.js';

const model = (id: string, enabled = true) =>
  ({ id, enabled, residency: 'eu', capabilities: [] }) as unknown as ModelDescription;

const items: Record<string, { scope: string; spec: Record<string, unknown> }> = {
  'egen-modell': { scope: '991825827', spec: {} },
  'annen-modell': { scope: '405003309', spec: {} },
  'delt-med-andre': { scope: 'platform', spec: { tenants: ['405003309'] } },
};

describe('models a tenant may use', () => {
  it('leaves out models owned by or shared only with another tenant, and turned off ones', () => {
    const deps = {
      catalog: { get: (_kind: string, id: string) => items[id] as never },
      models: {
        describe: () => [
          model('405003309/norsk-7b'),
          model('991825827/egen-7b'),
          model('annen-modell'),
          model('delt-med-andre'),
          model('egen-modell'),
          model('felles/gpt'),
          model('avslått', false),
        ],
      },
    };

    expect(modelsForTenant(deps, '991825827').map((m) => m.id)).toEqual([
      '991825827/egen-7b',
      'egen-modell',
      'felles/gpt',
    ]);
  });
});

describe('model display names', () => {
  const named = (id: string, deployment: string, family?: string) =>
    ({ id, deployment, ...(family ? { family } : {}) }) as unknown as ModelDescription;

  it('adds the deployment only to models whose names collide', () => {
    const names = modelDisplayNames([
      named('a/x', 'chat-1', 'gpt-chat-latest'),
      named('b/y', 'chat-2', 'gpt-chat-latest'),
      named('c/z', 'mini', 'o4-mini'),
      named('d/w', 'plain'),
    ]);
    expect(names.get('a/x')).toBe('gpt-chat-latest (chat-1)');
    expect(names.get('b/y')).toBe('gpt-chat-latest (chat-2)');
    expect(names.get('c/z')).toBe('o4-mini');
    expect(names.get('d/w')).toBe('d/w');
  });

  it('falls back to the model id when colliding models share a deployment name', () => {
    const names = modelDisplayNames([
      named('eu/chat', 'chat', 'gpt-chat-latest'),
      named('us/chat', 'chat', 'gpt-chat-latest'),
    ]);
    expect(names.get('eu/chat')).toBe('gpt-chat-latest (eu/chat)');
    expect(names.get('us/chat')).toBe('gpt-chat-latest (us/chat)');
  });
});
