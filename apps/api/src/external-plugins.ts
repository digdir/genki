import type { Evaluator } from '@genai/eval';
import { envSecrets, secretRefPattern, type PortContext, type SecretResolver } from '@genai/kernel';
import {
  declaredHosts,
  declaredSecrets,
  parseManifest,
  permissionProblems,
  type ContractSetup,
  type PluginManifest,
  type PluginRegistration,
  type PluginRegistry,
} from '@genai/plugins';
import { KnowledgeRouter, type KnowledgeAdapter } from '@genai/port-knowledge';
import {
  capabilities as modelCapabilities,
  ModelRouter,
  type Capability,
  type ModelAdapter,
} from '@genai/port-model';
import { modelContract, type ModelContractSubject } from '@genai/port-model/contract';
import { RerankRouter, type RerankAdapter } from '@genai/port-rerank';
import { rerankContract, type RerankContractSubject } from '@genai/port-rerank/contract';
import { ToolRegistry } from '@genai/port-tools';
import { toolSourceContract, type ToolSourceContractSubject } from '@genai/port-tools/contract';
import { A2aToolSource } from '@genai/providers-a2a-client';
import {
  ConnectionToolSources,
  EgressGuard,
  InMemoryConnections,
  McpToolSource,
  tenantSecretPattern,
  type EgressOptions,
} from '@genai/providers-mcp-client';
import { OpenApiToolSource } from '@genai/providers-openapi-tools';
import {
  createRemoteTransport,
  remoteAgentContract,
  type RegisteredAgent,
} from '@genai/strategy-remote';
import { z } from 'zod';
import {
  appendVersion,
  platformScope,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';
import {
  agentContract,
  evaluatorContract,
  httpJudge,
  searchEndpointContract,
  type AgentSubject,
  type EvaluatorSubject,
  type SearchEndpointSubject,
} from './plugin-contracts.js';

export const externalPluginKind = 'external-plugin';

export const codeKinds: Record<string, string> = {
  'step-block':
    'Steg i stegflyter er kode og legges til som en endring i plattformen. Vil du bruke egen logikk uten å endre plattformen, registrer en verktøykilde under /tenants/{tenant}/tool-connections og kall den fra en flyt med steget tool@1. Egne steg utenfra kommer senere.',
  blob: 'Fillager er kode og legges til som en endring i plattformen.',
  strategy:
    'Strategier er kode og legges til som en endring i plattformen. Vil du bruke din egen agent, lag en tjeneste med strategien remote-agent, som sender hver samtale til en adresse du driver selv.',
  guardrail:
    'Retningslinjer er kode og legges til som en endring i plattformen. Vil du sjekke svar med egen logikk, registrer en krok som kaller en adresse du driver selv.',
  hook: 'Kroker registreres under /operator/hooks eller /tenants/{tenant}/hooks.',
  skill: 'Ferdigheter registreres under /tenants/{tenant}/skills i Agent Skills-formatet.',
  trigger: 'Utløsere er en del av tjenesten og settes under spec.triggers i tjenestedefinisjonen.',
  frontend: 'Frontender registreres som klienter under /tenants/{tenant}/clients.',
};

const routedKinds = new Set(['model', 'rerank', 'knowledge']);

const endpointSchema = z.strictObject({
  baseURL: z.url({ protocol: /^https?$/ }),
  protocol: z.string().min(1),
  deployment: z.string().min(1).optional(),
  auth: z
    .strictObject({
      kind: z.enum(['bearer', 'api-key']),
      secret: z.string().refine((s) => secretRefPattern.test(s) || tenantSecretPattern.test(s), {
        message: 'must be a secret:// reference',
      }),
    })
    .optional(),
  allow: z
    .array(z.strictObject({ host: z.string().min(1), port: z.number().int().optional() }))
    .optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  document: z.string().max(2_000_000).optional(),
  example: z.strictObject({ tool: z.string().min(1), input: z.unknown() }).optional(),
  query: z.string().min(1).max(500).optional(),
});

export type ExternalEndpoint = z.output<typeof endpointSchema>;

export interface SharedConnection {
  tenant: string;
  connection: string;
}

export interface ExternalPlugin {
  manifest: PluginManifest;
  endpoint?: ExternalEndpoint;
  shared?: SharedConnection;
}

export const endpointProblems = (manifest: PluginManifest, endpoint: ExternalEndpoint) => [
  ...permissionProblems(manifest, {
    urls: [
      { path: 'endpoint.baseURL', url: endpoint.baseURL },
      ...(endpoint.allow ?? []).map((a, i) => ({
        path: `endpoint.allow.${i}`,
        url: `https://${a.host}${a.port ? `:${a.port}` : ''}`,
      })),
    ],
    secrets: endpoint.auth ? [{ path: 'endpoint.auth.secret', ref: endpoint.auth.secret }] : [],
  }),
  ...(routedKinds.has(manifest.kind) && !endpoint.auth
    ? [{ path: 'endpoint.auth', message: `a ${manifest.kind} endpoint needs auth` }]
    : []),
  ...(routedKinds.has(manifest.kind) &&
  endpoint.auth &&
  !secretRefPattern.test(endpoint.auth.secret)
    ? [
        {
          path: 'endpoint.auth.secret',
          message: `a ${manifest.kind} endpoint reads a platform secret, secret://<namespace>/<name>`,
        },
      ]
    : []),
];

export type ExternalCheck =
  | { ok: true; plugin: ExternalPlugin }
  | { ok: false; status: 400 | 422; errors: { path: string; message: string }[] };

export const checkExternalPlugin = (
  input: unknown,
  protocols: Record<string, string[]>,
): ExternalCheck => {
  const body = (input ?? {}) as { manifest?: Record<string, unknown>; endpoint?: unknown };
  const kind = String(body.manifest?.kind ?? '');
  if (codeKinds[kind])
    return {
      ok: false,
      status: 422,
      errors: [{ path: 'manifest.kind', message: codeKinds[kind] }],
    };
  const parsed = parseManifest({ ...body.manifest, origin: 'external' });
  if (!parsed.ok)
    return {
      ok: false,
      status: 400,
      errors: parsed.errors.map((e) => ({ ...e, path: `manifest.${e.path}` })),
    };
  if (body.endpoint === undefined) return { ok: true, plugin: { manifest: parsed.manifest } };
  const endpoint = endpointSchema.safeParse(body.endpoint);
  if (!endpoint.success)
    return {
      ok: false,
      status: 400,
      errors: endpoint.error.issues.map((i) => ({
        path: ['endpoint', ...i.path.map(String)].join('.'),
        message: i.message,
      })),
    };
  const known = protocols[parsed.manifest.kind];
  if (known && !known.includes(endpoint.data.protocol))
    return {
      ok: false,
      status: 400,
      errors: [
        {
          path: 'endpoint.protocol',
          message: `the platform speaks ${known.join(', ')} for ${parsed.manifest.kind}`,
        },
      ],
    };
  const problems = endpointProblems(parsed.manifest, endpoint.data);
  if (problems.length > 0) return { ok: false, status: 400, errors: problems };
  return { ok: true, plugin: { manifest: parsed.manifest, endpoint: endpoint.data } };
};

export interface ExternalTargetOptions {
  models: ModelAdapter[];
  rerank: RerankAdapter[];
  knowledge?: KnowledgeAdapter[];
  secrets: SecretResolver;
  egress?: EgressOptions;
  tenant: string;
}

const contextFor = (tenant: string, signal: AbortSignal): PortContext => ({
  tenant,
  principal: { kind: 'operator', issuer: 'platform', subject: 'contract-tests', tenant },
  task: 'contract',
  signal,
  meter: async () => undefined,
});

const catalogAuth = (endpoint: ExternalEndpoint) =>
  endpoint.auth
    ? endpoint.auth.kind === 'bearer'
      ? { kind: 'bearer', secret: endpoint.auth.secret }
      : { kind: 'api-key', secret: endpoint.auth.secret }
    : { kind: 'bearer', secret: 'secret://env/no-key' };

export const externalProtocols = (options: ExternalTargetOptions) => ({
  model: options.models.map((a) => a.protocol),
  rerank: options.rerank.map((a) => a.engine),
  knowledge: (options.knowledge ?? [])
    .filter((a) => a.engine === 'http-search' || a.engine === 'mcp')
    .map((a) => a.engine),
  'tool-source': ['mcp', 'a2a', 'openapi'],
  agent: ['http', 'a2a'],
  evaluator: ['http-judge'],
});

export const manifestAllow = (manifest: PluginManifest, baseURL: string) => {
  const url = new URL(baseURL);
  const fallback = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return declaredHosts(manifest)
    .filter((h) => !h.host.startsWith('*.'))
    .map((h) => ({ host: h.host, port: h.port ?? fallback }));
};

export const pluginConnectionId = (id: string) =>
  id
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

export const judgeSender =
  (
    guard: EgressGuard,
    manifest: PluginManifest,
    endpoint: ExternalEndpoint,
    secrets: SecretResolver,
  ) =>
  async (body: string, signal?: AbortSignal) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-genai-contract': 'evaluator@1',
    };
    if (endpoint.auth) {
      const value = await secrets.resolve(endpoint.auth.secret);
      if (endpoint.auth.kind === 'bearer') headers.authorization = `Bearer ${value}`;
      else headers['x-api-key'] = value;
    }
    const response = await guard.request(
      manifestAllow(manifest, endpoint.baseURL),
      endpoint.baseURL,
      { method: 'POST', headers, body, timeoutMs: 30_000 },
      signal,
    );
    return { status: response.status, body: response.body };
  };

export const externalTarget =
  (options: ExternalTargetOptions) =>
  (plugin: ExternalPlugin): ContractSetup<unknown> | undefined => {
    const { manifest, endpoint } = plugin;
    if (!endpoint) return undefined;
    const secrets: SecretResolver = endpoint.auth
      ? declaredSecrets(manifest, options.secrets)
      : envSecrets({ NO_KEY: 'none' });
    if (manifest.kind === 'model') {
      const adapter = options.models.find((a) => a.protocol === endpoint.protocol);
      if (!adapter) return undefined;
      const declared = manifest.capabilities.filter((c): c is Capability =>
        (modelCapabilities as readonly string[]).includes(c),
      );
      return async () => ({
        subject: {
          declared,
          open: (capabilities: Capability[], signal = new AbortController().signal) => {
            const router = new ModelRouter({
              catalog: {
                endpoints: {
                  external: {
                    protocol: adapter.protocol,
                    baseURL: endpoint.baseURL,
                    auth: catalogAuth(endpoint),
                  },
                },
                models: [
                  {
                    id: 'contract/model',
                    endpoint: 'external',
                    deployment: endpoint.deployment ?? manifest.id,
                    residency: manifest.dataLocation ?? 'global',
                    capabilities,
                  },
                ],
              },
              adapters: [adapter],
              secrets,
              maxRetries: 0,
              timeoutMs: 30_000,
            });
            const metered: ReturnType<ModelContractSubject['open']>['metered'] = [];
            const ctx = contextFor(options.tenant, signal);
            ctx.meter = async (usage, model) => {
              metered.push({ usage, ...(model ? { model } : {}) });
            };
            return { port: router.open({ kind: 'model', id: 'contract/model' }, ctx), metered };
          },
        } satisfies ModelContractSubject,
      });
    }
    if (manifest.kind === 'rerank') {
      const adapter = options.rerank.find((a) => a.engine === endpoint.protocol);
      if (!adapter) return undefined;
      return async () => ({
        subject: {
          open: ({ onFailure = 'fail', signal = new AbortController().signal } = {}) =>
            new RerankRouter({
              catalog: {
                endpoints: {
                  external: {
                    engine: adapter.engine,
                    baseURL: endpoint.baseURL,
                    auth: catalogAuth(endpoint),
                  },
                },
                rerankers: [
                  {
                    id: 'contract/reranker',
                    endpoint: 'external',
                    residency: manifest.dataLocation ?? 'global',
                    onFailure,
                  },
                ],
              },
              adapters: [adapter],
              secrets,
              timeoutMs: 30_000,
            }).open(
              { kind: 'reranker', id: 'contract/reranker' },
              contextFor(options.tenant, signal),
            ),
        } satisfies RerankContractSubject,
      });
    }
    if (manifest.kind === 'tool-source') {
      return async () => {
        const url = new URL(endpoint.baseURL);
        const registry = new InMemoryConnections();
        const guard = new EgressGuard(options.egress ?? {});
        const source = new ConnectionToolSources(registry, [
          new McpToolSource({ registry, secrets, guard }),
          new A2aToolSource({ registry, secrets, guard }),
          new OpenApiToolSource({ registry, secrets, guard }),
        ]);
        await registry.save({
          connection: {
            id: 'ekstern',
            tenant: options.tenant,
            name: manifest.title,
            protocol: endpoint.protocol as 'mcp' | 'a2a' | 'openapi',
            endpoint: endpoint.baseURL,
            version: '1',
            allow: endpoint.allow ?? manifestAllow(manifest, url.href),
            ...(endpoint.document ? { document: endpoint.document } : {}),
            ...(endpoint.auth && tenantSecretPattern.test(endpoint.auth.secret)
              ? { auth: { kind: 'bearer', secret: endpoint.auth.secret } }
              : {}),
          },
          tools: [],
          pending: [],
        });
        await source.sync(options.tenant, 'ekstern');
        const pinned = (await registry.get(options.tenant, 'ekstern'))?.tools ?? [];
        const name = endpoint.example
          ? `ekstern.${endpoint.example.tool}`
          : (pinned[0]?.name ?? 'ekstern.verktoy');
        return {
          subject: {
            provider: new ToolRegistry().addSource(source),
            tenant: options.tenant,
            tool: { name, version: '1', input: endpoint.example?.input ?? {} },
          } satisfies ToolSourceContractSubject,
        };
      };
    }
    if (manifest.kind === 'knowledge') {
      const adapter = options.knowledge?.find((a) => a.engine === endpoint.protocol);
      if (!adapter || !endpoint.auth) return undefined;
      const router = new KnowledgeRouter({
        catalog: {
          endpoints: {
            external: {
              engine: adapter.engine,
              baseURL: endpoint.baseURL,
              auth: catalogAuth(endpoint),
              options: endpoint.options ?? {},
            },
          },
          datasets: [
            { id: 'contract/search', endpoint: 'external', residency: 'norway', options: {} },
          ],
        },
        adapters: [adapter],
        secrets,
      });
      return async () => ({
        subject: {
          query: endpoint.query ?? 'test',
          open: (signal = new AbortController().signal) =>
            router.open(
              { kind: 'dataset', id: 'contract/search' },
              contextFor(options.tenant, signal),
            ),
        } satisfies SearchEndpointSubject,
      });
    }
    if (manifest.kind === 'agent') {
      const guard = new EgressGuard(options.egress ?? {});
      const transport = createRemoteTransport({ guard, secrets });
      const auth =
        endpoint.auth && tenantSecretPattern.test(endpoint.auth.secret)
          ? { auth: { kind: 'bearer' as const, secret: endpoint.auth.secret } }
          : {};
      return async () => ({
        subject: {
          query: endpoint.query ?? 'Hva kan du hjelpe med?',
          ask: (query, history, signal) =>
            transport.call({
              endpoint: {
                url: endpoint.baseURL,
                protocol: endpoint.protocol === 'a2a' ? 'a2a' : 'http',
                residency: manifest.dataLocation ?? 'global',
                timeoutMs: 30_000,
                maxResponseBytes: 2 * 1024 * 1024,
                ...auth,
              },
              owner: options.tenant,
              request: {
                contract: remoteAgentContract,
                conversation: { id: 'kontrakt', task: 'kontrakt' },
                query,
                messages: history,
                context: {
                  tenant: options.tenant,
                  caller: { tenant: options.tenant },
                  service: { id: 'kontrakt', version: '1' },
                },
                metadata: {},
              },
              signal,
            }),
        } satisfies AgentSubject,
      });
    }
    if (manifest.kind === 'evaluator') {
      const guard = new EgressGuard(options.egress ?? {});
      return async () => ({
        subject: {
          evaluator: httpJudge(manifest, judgeSender(guard, manifest, endpoint, secrets)),
          metrics: manifest.capabilities,
        } satisfies EvaluatorSubject,
      });
    }
    return undefined;
  };

const suiteFor = (kind: string) =>
  ({
    model: modelContract,
    rerank: rerankContract,
    'tool-source': toolSourceContract,
    knowledge: searchEndpointContract,
    agent: agentContract,
    evaluator: evaluatorContract,
  })[kind];

const latestPlugins = (entries: ConfigEntry<unknown>[]) =>
  entries
    .filter((e) => e.kind === externalPluginKind && e.scope === platformScope && !e.deleted)
    .map((e) => ({ entry: e, plugin: e.spec as ExternalPlugin }));

const derivedEntry = (
  from: ConfigEntry<unknown>,
  kind: string,
  id: string,
  spec: Record<string, unknown>,
): ConfigEntry<unknown> => ({
  kind,
  scope: platformScope,
  id,
  version: from.version,
  spec,
  deleted: false,
  by: from.by,
  at: from.at,
  reason: `plugin:${from.id}`,
});

export const pluginCatalogEntries = (entries: ConfigEntry<unknown>[]): ConfigEntry<unknown>[] =>
  latestPlugins(entries).flatMap(({ entry, plugin }) => {
    const { manifest, endpoint } = plugin;
    if (!endpoint || !routedKinds.has(manifest.kind)) return [];
    if (endpointProblems(manifest, endpoint).length > 0) return [];
    const auth = catalogAuth(endpoint);
    const residency = manifest.dataLocation ?? 'global';
    if (manifest.kind === 'model')
      return [
        derivedEntry(entry, 'model-endpoint', manifest.id, {
          protocol: endpoint.protocol,
          baseURL: endpoint.baseURL,
          auth,
          ...(endpoint.options ? { options: endpoint.options } : {}),
        }),
        derivedEntry(entry, 'model', manifest.id, {
          endpoint: manifest.id,
          deployment: endpoint.deployment ?? manifest.id,
          residency,
          capabilities: manifest.capabilities.filter((c) =>
            (modelCapabilities as readonly string[]).includes(c),
          ),
        }),
      ];
    if (manifest.kind === 'rerank')
      return [
        derivedEntry(entry, 'rerank-endpoint', manifest.id, {
          engine: endpoint.protocol,
          baseURL: endpoint.baseURL,
          auth,
          ...(endpoint.options ? { options: endpoint.options } : {}),
        }),
        derivedEntry(entry, 'reranker', manifest.id, { endpoint: manifest.id, residency }),
      ];
    return [
      derivedEntry(entry, 'knowledge-endpoint', manifest.id, {
        engine: endpoint.protocol,
        name: manifest.title,
        baseURL: endpoint.baseURL,
        auth,
        ...(endpoint.options ? { options: endpoint.options } : {}),
      }),
      derivedEntry(entry, 'dataset', manifest.id, {
        name: manifest.title,
        endpoint: manifest.id,
        residency,
      }),
    ];
  });

export const pluginEndpointHosts = (entries: ConfigEntry<unknown>[]) =>
  new Map(
    latestPlugins(entries).flatMap(({ plugin }) =>
      plugin.endpoint && routedKinds.has(plugin.manifest.kind)
        ? [[plugin.manifest.id, manifestAllow(plugin.manifest, plugin.endpoint.baseURL)] as const]
        : [],
    ),
  );

export const agentEndpointOf = (
  plugin: ExternalPlugin,
  platformTenant: string,
): RegisteredAgent | undefined => {
  const { manifest, endpoint } = plugin;
  if (manifest.kind !== 'agent' || !endpoint) return undefined;
  if (endpointProblems(manifest, endpoint).length > 0) return undefined;
  return {
    owner: platformTenant,
    endpoint: {
      url: endpoint.baseURL,
      protocol: endpoint.protocol === 'a2a' ? 'a2a' : 'http',
      residency: manifest.dataLocation ?? 'global',
      timeoutMs: 120_000,
      maxResponseBytes: 2 * 1024 * 1024,
      ...(endpoint.auth && tenantSecretPattern.test(endpoint.auth.secret)
        ? { auth: { kind: 'bearer' as const, secret: endpoint.auth.secret } }
        : {}),
    },
  };
};

export interface PluginBlock {
  kind: 'model' | 'dataset' | 'tool' | 'shared_service' | 'judge';
  id: string;
}

export const pluginBlockOf = (plugin: ExternalPlugin): PluginBlock | undefined => {
  const { kind, id } = plugin.manifest;
  if (plugin.shared) return { kind: 'tool', id: plugin.shared.connection };
  if (!plugin.endpoint) return undefined;
  if (kind === 'model' || kind === 'rerank') return { kind: 'model', id };
  if (kind === 'knowledge') return { kind: 'dataset', id };
  if (kind === 'tool-source') return { kind: 'tool', id: pluginConnectionId(id) };
  if (kind === 'agent') return { kind: 'shared_service', id };
  if (kind === 'evaluator') return { kind: 'judge', id };
  return undefined;
};

export const pluginEntries = async (store: ConfigEntryStore) =>
  latestPlugins(await store.latest({ kind: externalPluginKind, scope: platformScope })).map(
    (p) => p.plugin,
  );

export interface PluginRuntime {
  sharedTools: Map<string, string>;
  agents?: Map<string, RegisteredAgent>;
  evaluators?: Map<string, Evaluator>;
  judge?: (plugin: ExternalPlugin) => Evaluator | undefined;
}

export const externalPlugins = (
  store: ConfigEntryStore,
  registry: PluginRegistry,
  target: (plugin: ExternalPlugin) => ContractSetup<unknown> | undefined,
  runtime?: PluginRuntime & { platformTenant: string },
) => {
  const loaded = new Map<string, number>();
  const judges = new Set<string>();
  const apply = (plugins: ExternalPlugin[]) => {
    if (!runtime) return;
    const shared = new Map<string, string>();
    for (const plugin of plugins) {
      if (plugin.shared) shared.set(plugin.shared.connection, plugin.shared.tenant);
      else if (plugin.manifest.kind === 'tool-source' && plugin.endpoint)
        shared.set(pluginConnectionId(plugin.manifest.id), runtime.platformTenant);
    }
    runtime.sharedTools.clear();
    for (const [k, v] of shared) runtime.sharedTools.set(k, v);
    if (runtime.agents) {
      runtime.agents.clear();
      for (const plugin of plugins) {
        const agent = agentEndpointOf(plugin, runtime.platformTenant);
        if (agent) runtime.agents.set(plugin.manifest.id, agent);
      }
    }
    if (!runtime.evaluators || !runtime.judge) return;
    for (const id of judges) runtime.evaluators.delete(id);
    judges.clear();
    for (const plugin of plugins) {
      if (plugin.manifest.kind !== 'evaluator' || runtime.evaluators.has(plugin.manifest.id))
        continue;
      const judge = runtime.judge(plugin);
      if (!judge) continue;
      runtime.evaluators.set(plugin.manifest.id, judge);
      judges.add(plugin.manifest.id);
    }
  };
  const registrationOf = (plugin: ExternalPlugin): PluginRegistration => {
    const setup = target(plugin);
    const suite = suiteFor(plugin.manifest.kind);
    return setup && suite
      ? {
          manifest: plugin.manifest,
          suite: suite as NonNullable<PluginRegistration['suite']>,
          target: setup,
        }
      : { manifest: plugin.manifest };
  };
  const sync = async () => {
    const entries = await store.latest({ kind: externalPluginKind, scope: platformScope });
    for (const entry of entries) {
      if (loaded.get(entry.id) === entry.version) continue;
      if (loaded.has(entry.id)) registry.unregister(entry.id);
      loaded.set(entry.id, entry.version);
      if (!entry.deleted) registry.register(registrationOf(entry.spec as ExternalPlugin));
    }
    apply(latestPlugins(entries).map((p) => p.plugin));
  };
  return {
    sync,
    registrationOf,
    plugins: async () =>
      latestPlugins(await store.latest({ kind: externalPluginKind, scope: platformScope })).map(
        (p) => p.plugin,
      ),
    find: async (id: string) => {
      const latest = (await store.history(externalPluginKind, platformScope, id)).at(-1);
      return latest && !latest.deleted ? (latest.spec as ExternalPlugin) : undefined;
    },
    save: async (plugin: ExternalPlugin, by: string, reason: string, deleted = false) => {
      const saved = await appendVersion(store, {
        kind: externalPluginKind,
        scope: platformScope,
        id: plugin.manifest.id,
        spec: plugin,
        deleted,
        by,
        reason,
      });
      await sync();
      return saved;
    },
  };
};
