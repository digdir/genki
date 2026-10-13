import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Principal } from '@genai/contracts';
import { createKernel, type Strategy } from '@genai/kernel';
import {
  checkPromptFiles,
  serviceDefinition,
  strategyKey,
  toCapabilities,
  validateDefinition,
  type PluginSchemas,
  type ServiceDefinition,
} from './index.js';

const plugins: PluginSchemas = {
  strategies: new Map<string, z.ZodType>([[strategyKey('single-call', 1), z.looseObject({})]]),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  models: new Map([['m', { residency: 'norway', capabilities: ['stream'] }]]),
};

const service = (spec: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: '991825827', id: 'svar' },
  spec: {
    purpose: 'Svarer på spørsmål',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.', ...config } },
    model: { primary: 'm', residency: 'norway' },
    ...spec,
  },
});

const errors = (input: unknown) => {
  const result = validateDefinition(input, plugins);
  return result.ok ? [] : result.errors;
};

describe('service languages', () => {
  it('answers in bokmål and English unless the service lists its languages', () => {
    expect(serviceDefinition.parse(service()).spec.languages).toEqual(['nb', 'en']);
    expect(serviceDefinition.parse(service({ languages: ['nn'] })).spec.languages).toEqual(['nn']);
  });

  it('refuses a language other than nb, nn and en', () => {
    expect(serviceDefinition.safeParse(service({ languages: ['de'] })).success).toBe(false);
  });

  it('requires instructions for every listed language when instructions are given per language', () => {
    expect(errors(service({}, { instructions: { nb: 'Svar kort.' } }))).toEqual([
      {
        path: 'spec.strategy.config.instructions.en',
        message: 'the service answers in en but has no instructions for it',
      },
    ]);
    expect(errors(service({}, { instructions: { nb: 'Svar kort.', en: 'Be brief.' } }))).toEqual(
      [],
    );
  });

  it('checks per-language instructions in a mode override too', () => {
    const found = errors(
      service({
        variants: ['default', { id: 'kort', overrides: { instructions: { en: 'Brief.' } } }],
      }),
    );
    expect(found.map((e) => e.path)).toEqual(['spec.variants[1].overrides.instructions.nb']);
  });

  it('accepts a prompt file per language for the service text', () => {
    const definition = serviceDefinition.parse(
      service({}, { languageInstructions: { en: 'prompts/svar.en.md' } }),
    ) as ServiceDefinition;
    expect(checkPromptFiles(definition, { 'prompts/svar.en.md': 'Use plain English.' })).toEqual(
      [],
    );
    const [compiled] = toCapabilities(definition, 1, {
      'prompts/svar.en.md': 'Use plain English.',
    });
    const config = compiled?.capability.config as {
      languages: string[];
      strategy: { languageInstructions: Record<string, string> };
    };
    expect(config.strategy.languageInstructions.en).toBe('Use plain English.');
    expect(config.languages).toEqual(['nb', 'en']);
  });

  it('lets a mode override the service text per language through its overrides', () => {
    const definition = serviceDefinition.parse(
      service({
        variants: [
          'default',
          { id: 'kort', overrides: { languageInstructions: { en: 'Two sentences.' } } },
        ],
      }),
    ) as ServiceDefinition;
    const [, mode] = toCapabilities(definition, 1);
    expect(
      (mode?.capability.config as { strategy: { languageInstructions: unknown } }).strategy
        .languageInstructions,
    ).toEqual({ en: 'Two sentences.' });
  });

  it('changes the configuration hash when a service text for a language changes', async () => {
    const kari: Principal = { kind: 'employee', issuer: 't', subject: 'kari', tenant: '991825827' };
    const echo: Strategy<unknown> = {
      id: 'single-call',
      version: '1',
      requires: { kernel: 1, ports: [], features: [] },
      run: async function* () {
        yield { type: 'kernel.result', data: [] };
      },
    };
    const hashOf = async (text: string) => {
      const definition = serviceDefinition.parse(
        service({}, { languageInstructions: { en: text } }),
      ) as ServiceDefinition;
      const [compiled] = toCapabilities(definition, 1);
      if (!compiled) throw new Error('no capability');
      const capability = compiled.capability;
      const kernel = createKernel({
        strategies: [echo],
        capabilities: [capability],
        ports: {},
        policy: { decide: async () => ({ allow: true }) },
      });
      const run = await kernel.invoke(kari, capability.descriptor.id, { data: {} });
      await run.result;
      return (await kernel.task(kari, run.task)).service.configHash;
    };
    expect(await hashOf('Be brief.')).not.toBe(await hashOf('Be very brief.'));
  });
});
