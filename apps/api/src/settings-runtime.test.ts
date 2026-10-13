import { describe, expect, it } from 'vitest';
import type { Input, Principal } from '@genai/contracts';
import { platformSettings, SettingsRegistry } from '@genai/definitions';
import { overrideScope } from '@genai/identity';
import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import {
  applySettings,
  checkOverrides,
  answerLanguageFor,
  serviceOverridesOf,
  withSettings,
  writtenStandardFor,
} from './settings-runtime.js';

const tenant = '991825827';
const employee: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };
const key = (...settings: string[]): Principal => ({
  kind: 'agency-system',
  issuer: 'urn:genai:legacy-api-key',
  subject: 'k1',
  tenant,
  scopes: ['legacy:query', ...settings.map(overrideScope)],
});

const registry = () => new SettingsRegistry(platformSettings);

const serviceConfig = (settings: Record<string, unknown> = {}) => ({
  strategy: { generate: true },
  settings,
  model: { primary: 'gpt', tenant },
  knowledge: { datasets: [{ dataset: 'digdir/kudos' }], retrieval: { maxPerDocument: 4 } },
});

const ctx = (principal: Principal): InvocationContext =>
  ({
    principal,
    tenant,
    capability: { id: `${tenant}/ka/default`, version: '3' },
  }) as unknown as InvocationContext;

const recorder = (id: string) => {
  const seen: unknown[] = [];
  const strategy: Strategy<unknown> = {
    id,
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (_ctx, _input, config) {
      seen.push(config);
      yield { type: 'kernel.result', data: [] };
    },
  };
  return { strategy, seen };
};

const run = async (
  strategy: Strategy<unknown>,
  c: InvocationContext,
  input: Input,
  config: unknown,
) => {
  const events: Emitted[] = [];
  for await (const e of strategy.run(c, input, config)) events.push(e);
  return events;
};

describe('resolved settings at run time', () => {
  it('layers platform default, tenant, service definition and call, the later winning', async () => {
    const settings = registry();
    const { strategy, seen } = recorder('rag-single-shot');
    const wrapped = withSettings(settings, strategy);
    const input = (overrides?: Record<string, unknown>): Input => ({
      data: { query: 'q', ...(overrides ? { overrides } : {}) },
    });
    const topK = async (
      config: unknown,
      principal = employee,
      overrides?: Record<string, unknown>,
    ) => {
      await run(wrapped, ctx(principal), input(overrides), config);
      return (seen.at(-1) as { strategy: { topK?: number } }).strategy.topK;
    };

    expect(await topK(serviceConfig())).toBeUndefined();
    settings.setDefault('rag.topK', 20, 'drift', 'raise the floor');
    expect(await topK(serviceConfig())).toBe(20);
    settings.setTenant(tenant, 'rag.topK', 12);
    expect(await topK(serviceConfig())).toBe(12);
    expect(await topK(serviceConfig({ 'rag.topK': 8 }))).toBe(8);
    expect(await topK(serviceConfig({ 'rag.topK': 8 }), key('rag.topK'), { 'rag.topK': 3 })).toBe(
      3,
    );
  });

  it("keeps a service's own retrieval config above platform and tenant values", () => {
    const settings = registry();
    settings.setTenant(tenant, 'retrieval.maxPerDocument', 9);
    settings.setTenant(tenant, 'retrieval.rerank.enabled', true);
    const effective = settings.effective(tenant, {
      tenant,
      service: 'ka',
      version: 1,
      settings: {},
    });
    const applied = applySettings(serviceConfig(), effective, 'rag-single-shot') as {
      knowledge: { retrieval: { maxPerDocument: number; rerank: { enabled: boolean } } };
    };
    expect(applied.knowledge.retrieval.maxPerDocument).toBe(4);
    expect(applied.knowledge.retrieval.rerank.enabled).toBe(true);

    const fromService = applySettings(
      serviceConfig(),
      settings.effective(tenant, {
        tenant,
        service: 'ka',
        version: 1,
        settings: { 'retrieval.maxPerDocument': 2 },
      }),
      'rag-single-shot',
    ) as { knowledge: { retrieval: { maxPerDocument: number } } };
    expect(fromService.knowledge.retrieval.maxPerDocument).toBe(2);
  });

  it('routes each setting to the strategy that consumes it', () => {
    const settings = registry();
    settings.setTenant(tenant, 'synthesis.maxTokens', 800);
    settings.setTenant(tenant, 'synthesis.temperature', 0.3);
    settings.setTenant(tenant, 'planner.maxPhrases', 4);
    const effective = settings.effective(tenant);
    const agent = applySettings({ strategy: {} }, effective, 'agent-loop') as {
      strategy: Record<string, unknown>;
      knowledge: { planner: Record<string, unknown> };
    };
    expect(agent.strategy).toEqual({ synthesisMaxTokens: 800, synthesisTemperature: 0.3 });
    expect(agent.knowledge.planner).toEqual({ maxPhrases: 4 });
    const flow = applySettings({ strategy: { flow: 'f@1' } }, effective, 'step-flow') as {
      strategy: Record<string, unknown>;
    };
    expect(flow.strategy).toEqual({ flow: 'f@1' });
  });

  it('records the applied overrides and their sources as an audit event', async () => {
    const settings = registry();
    settings.setTenant(tenant, 'retrieval.rerank.enabled', true);
    const { strategy } = recorder('rag-single-shot');
    const events = await run(
      withSettings(settings, strategy),
      ctx(key('retrieval.*')),
      {
        data: {
          query: 'q',
          overrides: { 'retrieval.retrieveTopK': 30, 'retrieve-auto-filter': false },
        },
      },
      serviceConfig(),
    );
    expect(events[0]).toEqual({
      type: 'x.settings.applied',
      audience: 'audit',
      data: {
        overrides: { 'retrieval.retrieveTopK': 30, 'retrieval.autoFilter.enabled': false },
        effective: {
          'retrieval.rerank.enabled': { value: true, source: 'tenant' },
          'retrieval.retrieveTopK': { value: 30, source: 'call' },
          'retrieval.autoFilter.enabled': { value: false, source: 'call' },
        },
      },
    });
  });
});

describe('written standard', () => {
  it('resolves from platform, tenant, service and an allowed call override', () => {
    const settings = registry();
    const at = (config: unknown, principal = employee, overrides?: Record<string, unknown>) =>
      writtenStandardFor(
        settings,
        ctx(principal),
        { data: { query: 'q', ...(overrides ? { overrides } : {}) } },
        config,
      );

    expect(at(serviceConfig())).toBe('user');
    settings.setTenant(tenant, 'answers.writtenStandard', 'bokmal');
    expect(at(serviceConfig())).toBe('bokmal');
    expect(at(serviceConfig({ 'answers.writtenStandard': 'nynorsk' }))).toBe('nynorsk');
    expect(
      at(serviceConfig(), key('answers.writtenStandard'), { 'answers.writtenStandard': 'nynorsk' }),
    ).toBe('nynorsk');
    expect(at(serviceConfig(), employee, { 'answers.writtenStandard': 'nynorsk' })).toBe('bokmal');
  });

  it("puts the person's own preference above the tenant, and a service value above both", () => {
    const settings = registry();
    settings.setTenant(tenant, 'answers.writtenStandard', 'bokmal');
    const at = (config: unknown, overrides?: Record<string, unknown>) =>
      writtenStandardFor(
        settings,
        ctx(key('answers.writtenStandard')),
        { data: { query: 'q', ...(overrides ? { overrides } : {}) } },
        config,
        'nynorsk',
      );

    expect(at(serviceConfig())).toBe('nynorsk');
    expect(at(serviceConfig({ 'answers.writtenStandard': 'bokmal' }))).toBe('bokmal');
    expect(at(serviceConfig(), { 'answers.writtenStandard': 'user' })).toBe('user');
  });
});

describe('answer language', () => {
  it('answers in English for a person reading English unless the service or call fixes the written standard', () => {
    const settings = registry();
    settings.setTenant(tenant, 'answers.writtenStandard', 'nynorsk');
    const at = (
      config: unknown,
      person: { writtenStandard?: 'bokmal' | 'nynorsk' | 'user'; language?: string },
      overrides?: Record<string, unknown>,
    ) =>
      answerLanguageFor(
        settings,
        ctx(key('answers.writtenStandard')),
        { data: { query: 'q', ...(overrides ? { overrides } : {}) } },
        config,
        'Hva er fristen for å søke om tilskudd?',
        person,
      );

    expect(at(serviceConfig(), { language: 'en', writtenStandard: 'bokmal' })).toBe('en');
    expect(at(serviceConfig(), { language: 'nb' })).toBe('nn');
    expect(at(serviceConfig(), { writtenStandard: 'user' })).toBe('nb');
    expect(at(serviceConfig({ 'answers.writtenStandard': 'bokmal' }), { language: 'en' })).toBe(
      'nb',
    );
    expect(at(serviceConfig(), { language: 'en' }, { 'answers.writtenStandard': 'nynorsk' })).toBe(
      'nn',
    );
  });
});

describe('per-call override allowlist', () => {
  it('accepts only settings on the credential allowlist, with wildcards', () => {
    const settings = registry();
    expect(checkOverrides(settings, key('rag.topK'), { 'rag.topK': 5 })).toEqual({
      ok: true,
      settings: { 'rag.topK': 5 },
    });
    expect(
      checkOverrides(settings, key('retrieval.*'), { 'retrieval.rerank.enabled': true }).ok,
    ).toBe(true);
    const refused = checkOverrides(settings, key('rag.topK'), { 'synthesis.maxTokens': 10 });
    expect(refused).toEqual({
      ok: false,
      message:
        "Overrides refused: synthesis.maxTokens is not in the credential's list of overridable settings. Overridable with this credential: rag.topK.",
    });
  });

  it('refuses unknown settings and invalid values, and lets operators override anything', () => {
    const settings = registry();
    const operator: Principal = { kind: 'operator', issuer: 'test', subject: 'drift' };
    expect(checkOverrides(settings, operator, { 'nope.key': 1 })).toMatchObject({
      ok: false,
      message: expect.stringContaining('nope.key is not a setting'),
    });
    expect(checkOverrides(settings, operator, { 'rag.topK': 0 })).toMatchObject({ ok: false });
    expect(checkOverrides(settings, operator, { 'synthesis.maxTokens': 500 }).ok).toBe(true);
    expect(checkOverrides(settings, employee, { 'synthesis.maxTokens': 500 })).toMatchObject({
      ok: false,
      message: expect.stringContaining('Overridable with this credential: none'),
    });
  });

  it('puts the legacy override aliases through the same allowlist as their settings', () => {
    const settings = registry();
    expect(checkOverrides(settings, employee, { 'retrieve-top-k': 7 })).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        'retrieve-top-k (retrieval.retrieveTopK) is not in the credential',
      ),
    });
    expect(
      checkOverrides(settings, key('retrieval.retrieveTopK'), {
        'retrieve-top-k': 7,
        'retrieve-filter-by': { fields: [] },
      }),
    ).toEqual({ ok: true, settings: { 'retrieval.retrieveTopK': 7 } });
    expect(
      checkOverrides(settings, key('retrieve-auto-filter'), { 'retrieve-auto-filter': false }),
    ).toEqual({ ok: true, settings: { 'retrieval.autoFilter.enabled': false } });
    expect(
      checkOverrides(
        settings,
        key('retrieval.*'),
        { 'retrieve-top-k': 7 },
        serviceOverridesOf({ callOverrides: { mcp: ['rag.topK'] } }, 'mcp'),
      ).ok,
    ).toBe(false);
  });

  it('refuses a call override the service does not allow on that entry point', () => {
    const settings = registry();
    const config = { callOverrides: { mcp: ['rag.topK'], openai: [] } };
    const caller = key('rag.topK', 'retrieval.*');
    expect(
      checkOverrides(settings, caller, { 'rag.topK': 3 }, serviceOverridesOf(config, 'mcp')),
    ).toEqual({ ok: true, settings: { 'rag.topK': 3 } });
    expect(
      checkOverrides(settings, caller, { 'rag.topK': 3 }, serviceOverridesOf(config, 'openai')),
    ).toEqual({
      ok: false,
      message:
        'Overrides refused: rag.topK cannot be overridden on openai for this service. Overridable with this credential: rag.topK, retrieval.*. Overridable on openai for this service: none.',
    });
    expect(
      checkOverrides(
        settings,
        caller,
        { 'retrieval.retrieveTopK': 9 },
        serviceOverridesOf(config, 'rest'),
      ).ok,
    ).toBe(true);
  });

  it('leaves the credential alone in charge when a service names no entry-point allowlist', () => {
    expect(serviceOverridesOf({}, 'mcp')).toEqual({ entryPoint: 'mcp', allowed: '*' });
    expect(serviceOverridesOf({ callOverrides: { mcp: [] } })).toEqual({ allowed: '*' });
  });

  it('applies the allowlist of the entry point the run came in on', async () => {
    const { strategy, seen } = recorder('rag-single-shot');
    const wrapped = withSettings(registry(), strategy);
    const on = (entryPoint: string) =>
      ({ ...ctx(key('rag.topK')), entryPoint }) as InvocationContext;
    const input = { data: { query: 'q', overrides: { 'rag.topK': 3 } } };
    const config = { ...serviceConfig(), callOverrides: { a2a: [] } };
    await run(wrapped, on('mcp'), input, config);
    expect(seen).toHaveLength(1);
    await expect(run(wrapped, on('a2a'), input, config)).rejects.toThrow(
      /rag.topK cannot be overridden on a2a for this service/,
    );
    expect(seen).toHaveLength(1);
  });

  it('fails the run before the strategy starts when an override is refused', async () => {
    const { strategy, seen } = recorder('agent-loop');
    await expect(
      run(
        withSettings(registry(), strategy),
        ctx(employee),
        {
          data: { query: 'q', overrides: { 'synthesis.temperature': 1 } },
        },
        serviceConfig(),
      ),
    ).rejects.toThrow(/synthesis.temperature is not in the credential/);
    expect(seen).toHaveLength(0);
  });
});
