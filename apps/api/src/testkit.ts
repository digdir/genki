import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Principal } from '@genai/contracts';
import {
  InMemoryDefinitionStore,
  platformSettings,
  SettingsRegistry,
  strategyKey,
  type PluginSchemas,
  type SettingDefinition,
} from '@genai/definitions';
import { createAdmin } from './admin.js';
import { createApp, type PlatformOptions } from './app.js';
import type { Authenticator } from './http.js';
import {
  altinnPolicy,
  createAuthenticator,
  createMockAltinnPdp,
  InMemoryIdentities,
  type createTokenVerifier,
} from '@genai/identity';
import type { TriggerRunStore } from '@genai/jobs';
import { envSecrets } from '@genai/kernel';
import { callerFrom, createPlatform, platformModules, serviceRequirement } from './composition.js';
import { actorNames } from './actor-names.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import {
  admitMaskinportenClients,
  maskinportenClientRegistry,
  maskinportenClientsModule,
} from './maskinporten-clients.js';
import { onboardingModule } from './onboarding.js';
import type { PlatformModuleFactory } from './platform-modules.js';

export const digdir = '991825827';
export const other = '999888777';

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
const lovdataKey: SettingDefinition<string> = {
  ...topK,
  key: 'tools.lovdata.key',
  sensitivity: 'secret',
  schema: z.string(),
  default: '',
  settableAt: ['tenant'],
};
export const settingDefinitions = [topK, lovdataKey] as SettingDefinition[];

export const plugins: PluginSchemas = {
  strategies: new Map<string, z.ZodType>([
    [strategyKey('single-call', 1), z.strictObject({ instructions: z.string() })],
  ]),
  tools: new Map(),
  guardrails: new Map<string, z.ZodType>([
    ['language', z.strictObject({ mode: z.enum(['same', 'nb', 'nn']) })],
  ]),
  blocks: new Set(),
  models: new Map([['foundry/gpt-4o', { residency: 'norway', capabilities: ['stream'] }]]),
  settings: settingDefinitions,
};

export const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  operator: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
  'other-operator': { kind: 'operator', issuer: 'test', subject: 'vakt', tenant: digdir },
};

export const auth: Authenticator = {
  authenticate: async (request) =>
    principals[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''],
};

const examples = join(import.meta.dirname, '..', '..', '..', 'packages', 'definitions', 'examples');
export const klarsprakYaml = readFileSync(join(examples, 'klarsprak.yaml'), 'utf8');
export const files = {
  'prompts/klarsprak.nb.md': readFileSync(join(examples, 'prompts', 'klarsprak.nb.md'), 'utf8'),
};

export const klarsprak = (
  patch: {
    tenant?: string;
    id?: string;
    variants?: unknown[];
    settings?: Record<string, unknown>;
  } = {},
) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: patch.tenant ?? digdir, id: patch.id ?? 'klarsprak', name: 'Klarspråk' },
  spec: {
    purpose: 'Skriv om tekst til klart språk',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: {
      id: 'single-call',
      version: 1,
      config: { instructions: 'prompts/klarsprak.nb.md' },
    },
    model: { primary: 'foundry/gpt-4o', residency: 'norway' },
    exposure: { rest: true },
    ...(patch.variants ? { variants: patch.variants } : {}),
    ...(patch.settings ? { settings: patch.settings } : {}),
  },
});

export interface SendInit {
  method?: string;
  body?: unknown;
  yaml?: string;
  reason?: string;
  session?: string;
  actFor?: string;
  name?: string;
}

export const setup = (
  options: {
    minutes?: number;
    tenantQuota?: PlatformOptions['tenantQuota'];
    lifecycle?: PlatformOptions['lifecycle'];
    organisationName?: PlatformOptions['organisationName'];
  } = {},
) => {
  let clock = new Date('2026-10-06T10:00:00Z');
  const now = () => clock;
  const store = new InMemoryDefinitionStore(plugins, now);
  const settings = new SettingsRegistry(settingDefinitions, now);
  let ids = 0;
  const admin = createAdmin({
    store,
    plugins,
    settings,
    now,
    newId: () => `id-${++ids}`,
    ...(options.minutes ? { maxSupportMinutes: options.minutes } : {}),
  });
  const names = actorNames(new InMemoryConfigEntryStore());
  const app = createApp('test', {
    platform: {
      names,
      store,
      plugins,
      settings,
      auth,
      admin,
      now,
      tenantDirectory: async () => [{ orgNumber: other, name: 'Testetaten', status: 'onboarding' }],
      ...(options.tenantQuota ? { tenantQuota: options.tenantQuota } : {}),
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      ...(options.organisationName ? { organisationName: options.organisationName } : {}),
    },
  });
  const send = (path: string, who: string | undefined, init: SendInit = {}) =>
    app.request(path, {
      method: init.method ?? (init.body !== undefined || init.yaml ? 'POST' : 'GET'),
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(init.yaml ? { 'content-type': 'application/yaml' } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.reason ? { 'change-reason': init.reason } : {}),
        ...(init.session ? { 'support-session': init.session } : {}),
        ...(init.name ? { 'actor-name': encodeURIComponent(init.name) } : {}),
      },
      ...(init.yaml ? { body: init.yaml } : {}),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  const publish = (who: string, definition: unknown, reason = 'første versjon', session?: string) =>
    send('/definitions', who, {
      body: { definition, files },
      reason,
      ...(session ? { session } : {}),
    });
  const advance = (minutes: number) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };
  return { app, store, settings, admin, send, publish, advance };
};

export const fakeModels = {
  endpoints: {
    fake: {
      protocol: 'openai-chat',
      baseURL: 'https://modell.example.no/v1',
      auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
    },
  },
  models: [
    {
      id: 'fake/gpt',
      endpoint: 'fake',
      deployment: 'gpt',
      residency: 'norway',
      capabilities: ['stream', 'json-schema'],
    },
  ],
};

export const testService = (id: string, tenant?: string) => {
  const definition = klarsprak({ id, ...(tenant ? { tenant } : {}) });
  return {
    ...definition,
    spec: { ...definition.spec, model: { primary: 'fake/gpt', residency: 'norway' } },
  };
};

export interface BootOptions {
  people?: Record<string, Principal>;
  verifier?: ReturnType<typeof createTokenVerifier>;
  maskinportenIssuers?: string[];
  modules?: PlatformModuleFactory[];
  services?: string[];
  knowledge?: unknown;
  triggerRuns?: TriggerRunStore;
}

export const bootPlatform = async (options: BootOptions = {}) => {
  const people = options.people ?? {};
  const configEntries = new InMemoryConfigEntryStore();
  const settings = new SettingsRegistry(platformSettings);
  const authenticator = createAuthenticator(options.verifier ? { verifier: options.verifier } : {});
  const admit = admitMaskinportenClients(
    maskinportenClientRegistry(configEntries),
    options.maskinportenIssuers ?? [],
  );
  const resource = 'urn:altinn:resource:digdir-genai-platform';
  const platform = await createPlatform({
    catalogs: {
      models: fakeModels,
      knowledge: options.knowledge ?? { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    settings,
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p, skill, flow) => new InMemoryDefinitionStore(p, undefined, skill, flow),
    configurables: { store: configEntries, scheduleIntervalMs: 0 },
    ...(options.triggerRuns ? { triggerRuns: options.triggerRuns } : {}),
    modules: options.modules ?? [...platformModules, onboardingModule, maskinportenClientsModule],
    policy: altinnPolicy({
      altinn: createMockAltinnPdp({}).authorization,
      identities: new InMemoryIdentities(),
      requirementFor: () => serviceRequirement(resource),
    }),
    authenticate: async (request) => {
      const person = people[request.headers.get('authorization')?.slice(7) ?? ''];
      if (person) return { principal: person };
      const found = await authenticator.authenticate(request);
      return found && callerFrom({ ...found, principal: await admit(found.principal) });
    },
  });
  for (const id of options.services ?? [])
    await platform.definitions.publish(testService(id), 'test', 'test', files);
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
    models: platform.models,
    tenants: () => platform.directory.list(),
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      admin,
      auth: { authenticate: (request) => platform.caller(request) },
      tenantGate: platform.tenantGate,
      registered: platform.registered,
      caller: platform.caller,
    },
  });
  platform.mount(app, admin);
  const send = (
    path: string,
    as: string,
    init: {
      method?: string;
      body?: unknown;
      reason?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        ...(init.reason ? { 'change-reason': init.reason } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { app, send, platform, admin, configEntries, settings };
};

export const readJson = async <T>(response: Response) => (await response.json()) as T;
