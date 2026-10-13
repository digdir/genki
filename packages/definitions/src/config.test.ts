import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  checkPromptFiles,
  exportTenant,
  importTenant,
  InMemoryDefinitionStore,
  SettingsRegistry,
  strategyKey,
  validateDefinition,
  type PluginSchemas,
  type ServiceSettings,
  type SettingDefinition,
} from './index.js';

const examples = join(import.meta.dirname, '..', 'examples');
const example = (name: string) =>
  parseYaml(readFileSync(join(examples, name), 'utf8')) as Record<string, unknown>;
const prompt = (name: string) => readFileSync(join(examples, 'prompts', name), 'utf8');

const digdir = '991825827';
const nav = '889640782';

const topK: SettingDefinition<number> = {
  key: 'search.topK',
  description: 'How many results a search returns',
  category: 'Søk',
  axis: 'service',
  sensitivity: 'normal',
  schema: z.number().int().min(1).max(200),
  default: 100,
  settableAt: ['platform', 'tenant', 'service', 'call'],
};
const temperature: SettingDefinition<number> = {
  ...topK,
  key: 'model.temperature',
  schema: z.number().min(0).max(2),
  default: 0.2,
};
const lovdataKey: SettingDefinition<string> = {
  ...topK,
  key: 'tools.lovdata.key',
  sensitivity: 'secret',
  schema: z.string(),
  default: '',
  settableAt: ['tenant'],
};
const definitions = [topK, temperature, lovdataKey] as SettingDefinition[];

const plugins: PluginSchemas = {
  strategies: new Map<string, z.ZodType>([
    [strategyKey('single-call', 1), z.strictObject({ instructions: z.string() })],
  ]),
  tools: new Map(),
  guardrails: new Map<string, z.ZodType>([
    ['language', z.strictObject({ mode: z.enum(['same', 'nb', 'nn']) })],
  ]),
  blocks: new Set(),
  models: new Map([['foundry/gpt-4o', { residency: 'norway', capabilities: ['stream'] }]]),
  settings: definitions,
};

const klarsprak = (tenant = digdir, settings: Record<string, unknown> = {}) => {
  const base = example('klarsprak.yaml');
  return {
    ...base,
    metadata: { ...(base.metadata as object), tenant },
    spec: { ...(base.spec as object), settings },
  };
};
const files = { 'prompts/klarsprak.nb.md': prompt('klarsprak.nb.md') };

const clock = () => new Date('2026-10-06T12:00:00Z');

describe('prompt files', () => {
  it('stores the prompt with the version and gives the strategy its text', async () => {
    const store = new InMemoryDefinitionStore(plugins, clock);

    const published = await store.publish(klarsprak(), 'kari', 'første', files);

    expect(published.ok && published.version.files).toEqual(files);
    const config = published.ok
      ? (published.capabilities[0]?.capability.config as { strategy: { instructions: string } })
      : undefined;
    expect(config?.strategy.instructions).toContain('Språkrådets sjekkliste');
    const resolved = await store.resolve('klarsprak__default');
    expect(
      (resolved?.capability.config as { strategy: { instructions: string } }).strategy.instructions,
    ).toBe(files['prompts/klarsprak.nb.md']);
  });

  it('refuses a publish whose prompt file is missing, unused, empty or outside prompts/', async () => {
    const store = new InMemoryDefinitionStore(plugins, clock);

    const missing = await store.publish(klarsprak(), 'kari', 'mangler fil');
    const extra = await store.publish(klarsprak(), 'kari', 'ekstra', {
      ...files,
      'prompts/annet.md': 'x',
      '../hemmelig.md': 'x',
    });
    const empty = await store.publish(klarsprak(), 'kari', 'tom', {
      'prompts/klarsprak.nb.md': '  ',
    });

    expect(missing.ok ? [] : missing.errors).toEqual([
      {
        path: 'spec.strategy.config.instructions',
        message: 'missing prompt file prompts/klarsprak.nb.md',
      },
    ]);
    expect(extra.ok ? [] : extra.errors.map((e) => e.path)).toEqual([
      'files.prompts/annet.md',
      'files.../hemmelig.md',
    ]);
    expect(empty.ok ? [] : empty.errors.map((e) => e.message)).toEqual([
      'a prompt file cannot be empty',
    ]);
  });

  it('keeps each version with its own prompt text', async () => {
    const store = new InMemoryDefinitionStore(plugins, clock);
    await store.publish(klarsprak(), 'kari', 'første', files);
    await store.publish(klarsprak(), 'kari', 'ny prompt', {
      'prompts/klarsprak.nb.md': 'Skriv kort.',
    });

    expect((await store.get('Service', digdir, 'klarsprak', 1))?.files).toEqual(files);
    expect((await store.get('Service', digdir, 'klarsprak', 2))?.files).toEqual({
      'prompts/klarsprak.nb.md': 'Skriv kort.',
    });
  });

  it('finds prompt references anywhere in the spec, including variant overrides', () => {
    const definition = {
      ...klarsprak(),
      spec: {
        ...(klarsprak().spec as object),
        variants: [{ id: 'nynorsk', overrides: { instructions: 'prompts/klarsprak.nn.md' } }],
      },
    };
    const validated = validateDefinition(definition, plugins);
    if (!validated.ok) throw new Error('invalid');

    expect(checkPromptFiles(validated.definition, files).map((e) => e.message)).toEqual([
      'missing prompt file prompts/klarsprak.nn.md',
    ]);
  });
});

describe('service settings in a definition', () => {
  it('accepts known settings at the service layer and refuses the rest', () => {
    const ok = validateDefinition(klarsprak(digdir, { 'search.topK': 20 }), plugins);
    const bad = validateDefinition(
      klarsprak(digdir, { 'search.topK': 999, 'tools.lovdata.key': 'secret://x/y', colour: 'red' }),
      plugins,
    );

    expect(ok.ok).toBe(true);
    expect(bad.ok ? [] : bad.errors.map((e) => e.path)).toEqual([
      'spec.settings.search.topK',
      'spec.settings.tools.lovdata.key',
      'spec.settings.colour',
    ]);
  });
});

describe('settings registry', () => {
  const service = (
    settings: Record<string, unknown> = {},
    tenant = digdir,
    id = 'klarsprak',
  ): ServiceSettings => ({
    tenant,
    service: id,
    version: 1,
    settings,
  });

  it('explains every value: the winning layer, what it overrode and the default version', () => {
    const registry = new SettingsRegistry(definitions, clock);
    registry.setDefault('search.topK', 80, 'operator:drift', 'færre treff');
    registry.setTenant(digdir, 'search.topK', 60);

    const effective = registry.effective(digdir, service({ 'search.topK': 40 }), {
      'search.topK': 10,
    });

    expect(effective['search.topK']).toMatchObject({
      value: 10,
      source: 'call',
      defaultVersion: 2,
      overridden: [
        { layer: 'default', value: 100 },
        { layer: 'platform', value: 80 },
        { layer: 'tenant', value: 60 },
        { layer: 'service', value: 40 },
      ],
    });
    expect(effective['model.temperature']).toMatchObject({ value: 0.2, source: 'default' });
  });

  it('versions platform defaults with a changelog and lets a tenant pin an older one', () => {
    const registry = new SettingsRegistry(definitions, clock);
    registry.setDefault('search.topK', 80, 'operator:drift', 'færre treff');
    registry.setDefault('search.topK', 50, 'operator:drift', 'enda færre');

    expect(registry.changelog('search.topK').map((c) => [c.version, c.value, c.reason])).toEqual([
      [2, 80, 'færre treff'],
      [3, 50, 'enda færre'],
    ]);
    expect(registry.pin(nav, 'search.topK', 2).ok).toBe(true);
    expect(registry.pin(nav, 'search.topK', 9).ok).toBe(false);
    expect(registry.effective(nav)['search.topK']).toMatchObject({
      value: 80,
      source: 'pin',
      pinnedVersion: 2,
    });
    expect(registry.effective(digdir)['search.topK']).toMatchObject({
      value: 50,
      source: 'platform',
    });
  });

  it('shows which services a default change reaches and which are pinned or override it', () => {
    const registry = new SettingsRegistry(definitions, clock);
    registry.pin(nav, 'search.topK', 1);
    const services = [
      service({}, digdir, 'klarsprak'),
      service({ 'search.topK': 30 }, digdir, 'kunnskapsassistenten'),
      service({}, nav, 'nav-hjelp'),
    ];

    const impact = registry.previewDefault('search.topK', 60, services);

    expect(impact.ok && impact.value.map((i) => [i.service, i.status, i.before, i.after])).toEqual([
      ['klarsprak', 'changes', 100, 60],
      ['kunnskapsassistenten', 'overridden', 30, 30],
      ['nav-hjelp', 'pinned', 100, 100],
    ]);
    expect(registry.defaultOf('search.topK')?.version).toBe(1);
  });

  it('previews a tenant change without applying it', () => {
    const registry = new SettingsRegistry(definitions, clock);
    const preview = registry.previewTenant(digdir, 'search.topK', 25, [
      service({}, digdir, 'klarsprak'),
      service({ 'search.topK': 5 }, digdir, 'ka'),
      service({}, nav, 'other'),
    ]);

    expect(preview.ok && preview.value).toEqual({
      tenant: {
        key: 'search.topK',
        before: 100,
        after: 25,
        beforeSource: 'default',
        afterSource: 'tenant',
      },
      services: [
        {
          tenant: digdir,
          service: 'klarsprak',
          version: 1,
          status: 'changes',
          before: 100,
          after: 25,
        },
        { tenant: digdir, service: 'ka', version: 1, status: 'overridden', before: 5, after: 5 },
      ],
    });
    expect(registry.tenant(digdir).values).toEqual({});
  });

  it('refuses unknown settings, invalid values, plain secrets and locked settings', () => {
    const registry = new SettingsRegistry(definitions, clock);
    registry.lock('model.temperature', 'fastsatt av Digdir');

    expect(registry.setTenant(digdir, 'colour', 'red').ok).toBe(false);
    expect(registry.setTenant(digdir, 'search.topK', 0).ok).toBe(false);
    expect(registry.setTenant(digdir, 'tools.lovdata.key', 'sk-123').ok).toBe(false);
    expect(registry.setTenant(digdir, 'tools.lovdata.key', 'secret://991825827/lovdata').ok).toBe(
      true,
    );
    const locked = registry.setTenant(digdir, 'model.temperature', 1);
    expect(locked.ok ? [] : locked.errors[0]?.message).toBe('locked: fastsatt av Digdir');
    expect(registry.setDefault('tools.lovdata.key', 'secret://x/y', 'op', 'nei').ok).toBe(false);
  });
});

describe('export and import', () => {
  const setup = async () => {
    const store = new InMemoryDefinitionStore(plugins, clock);
    const settings = new SettingsRegistry(definitions, clock);
    await store.publish(klarsprak(), 'kari', 'første', files);
    settings.setTenant(digdir, 'search.topK', 40);
    settings.setTenant(digdir, 'tools.lovdata.key', 'secret://991825827/lovdata');
    settings.setDefault('search.topK', 80, 'op', 'ny standard');
    settings.pin(digdir, 'search.topK', 1);
    return { store, settings };
  };
  const check = (definition: unknown, f: Record<string, string>) => {
    const v = validateDefinition(definition, plugins);
    return v.ok ? checkPromptFiles(v.definition, f) : v.errors;
  };

  it('exports definitions, prompt files and settings, with secrets only as references', async () => {
    const { store, settings } = await setup();

    const bundle = await exportTenant(digdir, store, settings, clock);

    expect(bundle.definitions.map((d) => d.files)).toEqual([files]);
    expect(bundle.settings).toEqual({
      values: { 'search.topK': 40, 'tools.lovdata.key': 'secret://991825827/lovdata' },
      pins: { 'search.topK': 1 },
    });
    expect(bundle.definitions[0]?.definition.metadata).not.toHaveProperty('version');
  });

  it('clones a tenant into another with a dry run first, then for real', async () => {
    const { store, settings } = await setup();
    const bundle = await exportTenant(digdir, store, settings, clock);
    const bundleForNav = {
      ...bundle,
      definitions: bundle.definitions.map((d) => ({
        ...d,
        definition: {
          ...d.definition,
          spec: {
            ...(d.definition.spec as object),
            variants: [{ id: 'default', publicName: 'nav-klarsprak' }],
          },
        },
      })),
    };
    const options = {
      tenant: nav,
      onConflict: 'skip' as const,
      actor: 'op',
      reason: 'kloning',
      check,
    };

    const dry = await importTenant(bundleForNav, store, settings, { ...options, dryRun: true });
    expect(dry).toMatchObject({ ok: true, dryRun: true });
    expect(await store.list(nav)).toEqual([]);

    const real = await importTenant(bundleForNav, store, settings, { ...options, dryRun: false });
    expect(real.ok && real.plan.map((p) => [p.target, p.action])).toEqual([
      ['Service:klarsprak', 'create'],
      ['setting:search.topK', 'create'],
      ['setting:tools.lovdata.key', 'create'],
      ['pin:search.topK', 'create'],
    ]);
    expect((await store.get('Service', nav, 'klarsprak'))?.files).toEqual(files);
    expect(settings.effective(nav)['search.topK']).toMatchObject({ value: 40, source: 'tenant' });
  });

  it('reports conflicts and either skips or overwrites them', async () => {
    const { store, settings } = await setup();
    const bundle = await exportTenant(digdir, store, settings, clock);
    settings.setTenant(digdir, 'search.topK', 15);
    await store.publish(klarsprak(), 'kari', 'endret prompt', {
      'prompts/klarsprak.nb.md': 'Kort.',
    });
    const options = { tenant: digdir, actor: 'op', reason: 'tilbake', check, dryRun: false };

    const skipped = await importTenant(bundle, store, settings, { ...options, onConflict: 'skip' });
    expect(
      skipped.ok && skipped.plan.filter((p) => p.conflict).map((p) => [p.target, p.action]),
    ).toEqual([
      ['Service:klarsprak', 'skip'],
      ['setting:search.topK', 'skip'],
    ]);
    expect(settings.tenant(digdir).values['search.topK']).toBe(15);

    const overwritten = await importTenant(bundle, store, settings, {
      ...options,
      onConflict: 'overwrite',
    });
    expect(overwritten.ok).toBe(true);
    expect(settings.tenant(digdir).values['search.topK']).toBe(40);
    expect((await store.get('Service', digdir, 'klarsprak'))?.version).toBe(3);
    expect((await store.get('Service', digdir, 'klarsprak'))?.files).toEqual(files);
  });

  it('refuses a malformed bundle, a plain secret and an invalid definition before changing anything', async () => {
    const { store, settings } = await setup();
    const bundle = await exportTenant(digdir, store, settings, clock);
    const options = {
      tenant: nav,
      onConflict: 'skip' as const,
      actor: 'op',
      reason: 'x',
      check,
      dryRun: false,
    };

    const malformed = await importTenant({ format: 'other' }, store, settings, options);
    const plainSecret = await importTenant(
      { ...bundle, settings: { values: { 'tools.lovdata.key': 'sk-live' }, pins: {} } },
      store,
      settings,
      options,
    );
    const broken = await importTenant(
      {
        ...bundle,
        definitions: [
          { definition: { ...bundle.definitions[0]?.definition, spec: {} }, files: {} },
        ],
      },
      store,
      settings,
      options,
    );

    expect(malformed.ok).toBe(false);
    expect(plainSecret.ok ? [] : plainSecret.errors.map((e) => e.path)).toEqual([
      'settings.values.tools.lovdata.key',
    ]);
    expect(broken.ok).toBe(false);
    expect(await store.list(nav)).toEqual([]);
    expect(settings.tenant(nav)).toEqual({ values: {}, pins: {} });
  });

  const withoutSettings = ({ settings: _settings, ...rest }: PluginSchemas) => rest;

  it('every example service validates with its prompt files', () => {
    const allFiles = Object.fromEntries(
      readdirSync(join(examples, 'prompts')).map((f) => [`prompts/${f}`, prompt(f)]),
    );
    for (const file of readdirSync(examples).filter((f) => f.endsWith('.yaml'))) {
      const v = validateDefinition(example(file), {
        ...withoutSettings(plugins),
        retrieval: z.unknown(),
        rerankers: new Set(['colbert']),
        strategies: new Map([
          ...plugins.strategies,
          [strategyKey('agent-loop', 1), z.unknown()],
          [strategyKey('step-flow', 1), z.unknown()],
          [strategyKey('remote-agent', 1), z.unknown()],
        ]),
        tools: new Map([
          ['rag@1', z.unknown()],
          ['digdir.klarsprak@2.3', z.unknown()],
          ['mcp-client@1', z.unknown()],
          ['saker.sok@1', z.unknown()],
        ]),
        guardrails: new Map([
          ['language', z.unknown()],
          ['pii-before-model', z.unknown()],
          ['pii-out-of-log', z.unknown()],
          ['require-sources', z.unknown()],
          ['human-approval', z.unknown()],
          ['refuse-topics', z.unknown()],
        ]),
        blocks: new Set([
          'classify@1',
          'route@1',
          'documents@1',
          'read-document@1',
          'extract@1',
          'table@1',
          'tool@1',
          'model@1',
        ]),
        models: new Map([
          [
            'foundry/gpt-4o',
            { residency: 'norway', capabilities: ['stream', 'tools', 'json-schema'] },
          ],
          ['aivar/borealis', { residency: 'norway', capabilities: ['stream', 'tools'] }],
        ]),
      });
      if (!v.ok) throw new Error(`${file}: ${JSON.stringify(v.errors)}`);
      const used = Object.fromEntries(
        Object.entries(allFiles).filter(([n]) => JSON.stringify(v.definition).includes(n)),
      );
      expect(checkPromptFiles(v.definition, used)).toEqual([]);
    }
  });
});
