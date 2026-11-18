import { describe, expect, it } from 'vitest';
import type { Evaluator } from '@genai/eval';
import { manifest, PluginRegistry } from '@genai/plugins';
import { InMemoryConfigEntryStore } from './config-store.js';
import { externalPlugins, judgeSender, type ExternalPlugin } from './external-plugins.js';

const judgeOf = (contract: string): ExternalPlugin => ({
  manifest: manifest({
    kind: 'evaluator',
    id: 'evaluator.dommer',
    version: '1',
    contract,
    title: 'Ekstern dommer',
    capabilities: ['korrekthet'],
    hosts: ['dommer.example'],
  }),
  endpoint: { baseURL: 'https://dommer.example', protocol: 'http-judge' },
});

describe('stored evaluator plug-ins', () => {
  it('judges nothing with a stored evaluator@1 plug-in until it is registered again under evaluator@2', async () => {
    const registry = new PluginRegistry();
    const evaluators = new Map<string, Evaluator>();
    const external = externalPlugins(
      new InMemoryConfigEntryStore(),
      registry,
      () => async () => ({ subject: {} }),
      {
        platformTenant: '991825827',
        sharedTools: new Map(),
        evaluators,
        judge: (plugin) => ({
          id: plugin.manifest.id,
          version: plugin.manifest.version,
          kind: 'model',
          evaluate: async () => [],
        }),
      },
    );

    await external.save(judgeOf('evaluator@1'), 'ops', 'Lagret før evaluator@2');
    expect(registry.get('evaluator.dommer')?.manifest.contract).toBe('evaluator@1');
    expect(evaluators.has('evaluator.dommer')).toBe(false);

    await external.save(judgeOf('evaluator@2'), 'ops', 'Registrert på nytt under evaluator@2');
    expect(evaluators.has('evaluator.dommer')).toBe(true);
  });
});

describe('the judge sender', () => {
  it('passes the signal on to the egress request', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const guard = {
      request: async (_allow: unknown, _url: unknown, _req: unknown, signal?: AbortSignal) => {
        seen.push(signal);
        return { status: 200, body: '{}' };
      },
    };
    const plugin = judgeOf('evaluator@2');
    const send = judgeSender(
      guard as never,
      plugin.manifest,
      plugin.endpoint as NonNullable<ExternalPlugin['endpoint']>,
      {} as never,
    );
    const signal = new AbortController().signal;

    await send('{}', signal);

    expect(seen).toEqual([signal]);
  });
});
