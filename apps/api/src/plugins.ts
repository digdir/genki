import type { Principal } from '@genai/contracts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  builtinHookPlugins,
  hookContract,
  hookContractVersion,
  hookSpec,
  type HookCall,
  type HookConfig,
} from '@genai/hooks';
import {
  manifest,
  parseManifest,
  PluginError,
  PluginRegistry,
  type ContractRun,
  type ContractRunStore,
  type PluginEntry,
  type PluginRegistration,
} from '@genai/plugins';
import {
  blobContract,
  blobContractVersion,
  fileSystemBlobContractTarget,
  memoryBlobContractTarget,
} from '@genai/port-blob/contract';
import { tenantSecretPattern } from '@genai/providers-mcp-client';
import {
  builtinToolsContractTarget,
  toolSourceContract,
  toolSourceContractVersion,
} from '@genai/port-tools/contract';
import { blockRef, type BlockRegistry } from '@genai/strategy-step-flow';
import { stepBlockContract, stepBlockContractVersion } from '@genai/strategy-step-flow/contract';
import type { Context } from 'hono';
import { z } from 'zod';
import { enterTenant } from './access.js';
import { actorOf, type AdminHandler } from './admin.js';
import { appendVersion, platformScope, type ConfigEntryStore } from './config-store.js';
import type { EngineDescription } from './knowledge-engines.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import { verifyWebhookSignature } from './webhooks.js';
import { webhookHookSender } from './hooks.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { translate, translatorFor, type ApiKey } from './i18n/index.js';
import { adoptionKind, blockKey } from '@genai/composition';
import {
  agentEndpointOf,
  checkExternalPlugin,
  pluginBlockOf,
  type PluginBlock,
  externalPlugins,
  manifestAllow,
  pluginConnectionId,
  type ExternalPlugin,
} from './external-plugins.js';

export const contractRunKind = 'plugin-contract-run';

type ModelSpec = Record<string, string | Record<string, string> | undefined>;

interface ServiceSpec {
  model?: ModelSpec;
  variants?: { model?: ModelSpec; strategy?: ServiceSpec['strategy'] }[];
  knowledge?: { datasets?: { dataset?: string }[]; reranker?: string };
  tools?: (string | { use?: string })[];
  strategy?: { id?: string; config?: { agent?: unknown } };
}

export const configContractRuns = (store: ConfigEntryStore): ContractRunStore => ({
  record: async (run) => {
    await appendVersion(store, {
      kind: contractRunKind,
      scope: platformScope,
      id: run.plugin,
      spec: run,
      deleted: false,
      by: run.by ?? `platform:${run.trigger}`,
      reason: `Kontrakttester for ${run.plugin} ${run.version}`,
    });
  },
  list: async (plugin) =>
    (await store.history(contractRunKind, platformScope, plugin)).map((e) => e.spec as ContractRun),
});

const webhookSecret = 'kontrakt-hemmelighet';

const webhookHookTarget = async () => {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const signature = String(req.headers['genai-signature'] ?? '');
      if (!verifyWebhookSignature(webhookSecret, signature, raw)) {
        res.writeHead(401);
        return res.end();
      }
      const body = JSON.parse(raw) as { payload?: unknown };
      const refuse = JSON.stringify(body.payload ?? {}).includes('hemmelig');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          refuse ? { decision: 'refuse', reason: 'mottakeren sa nei' } : { decision: 'allow' },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/krok`;
  const send = webhookHookSender({
    secrets: { resolve: async () => webhookSecret },
    send: async (target, init, signal) => {
      const response = await fetch(target, { method: 'POST', ...init, signal });
      return { status: response.status, body: await response.text() };
    },
  });
  const hook = {
    id: 'kontrakt',
    scope: platformScope,
    ...hookSpec.parse({
      name: 'Kontrakt',
      point: 'before_model',
      mode: 'enforce',
      handler: { kind: 'webhook', url: 'https://mottaker.example.no/krok', secret: 'krok' },
    }),
  } as HookConfig & { handler: { kind: 'webhook'; url: string; secret: string } };
  const example = (text: string): HookCall => ({
    point: 'before_model',
    tenant: '991825827',
    payload: { messages: [{ role: 'user', content: text }] },
  });
  return {
    subject: {
      invoke: (call: HookCall, signal: AbortSignal) =>
        send({ ...hook, handler: { ...hook.handler, url } }, call, signal),
      examples: { allow: example('Hei'), refuse: example('Dette er hemmelig') },
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const builtinTitles: Record<string, ApiKey> = {
  'tool-source.builtin': 'services.pluginBuiltinTools',
  'blob.memory': 'services.pluginMemoryBlob',
  'blob.filesystem': 'services.pluginDiskBlob',
  'knowledge.http-search': 'services.engineHttp',
  'knowledge.mcp': 'services.engineMcp',
};

const pluginTitle = (id: string, title: string) => {
  const key = builtinTitles[id];
  return key && title === translatorFor('nb').template(key) ? translate(key) : title;
};

export const builtinPlugins = (
  blocks: BlockRegistry,
  engines: EngineDescription[] = [],
): PluginRegistration[] => [
  {
    manifest: manifest({
      kind: 'tool-source',
      id: 'tool-source.builtin',
      version: '1',
      contract: toolSourceContractVersion,
      title: 'Innebygde verktøy',
      description: 'Tools that run inside the platform, with input checked against their schema.',
    }),
    suite: toolSourceContract,
    target: builtinToolsContractTarget,
  },
  {
    manifest: manifest({
      kind: 'blob',
      id: 'blob.memory',
      version: '1',
      contract: blobContractVersion,
      title: 'Minnelager',
      description: 'Files kept in memory, for tests and local runs.',
      dataLocation: 'norway',
    }),
    suite: blobContract,
    target: memoryBlobContractTarget,
  },
  {
    manifest: manifest({
      kind: 'blob',
      id: 'blob.filesystem',
      version: '1',
      contract: blobContractVersion,
      title: 'Fillager på disk',
      description: 'Files on a disk the platform runs on, with atomic writes.',
      dataLocation: 'norway',
      configSchema: { type: 'object', properties: { root: { type: 'string' } } },
    }),
    suite: blobContract,
    target: fileSystemBlobContractTarget,
  },
  ...blocks.refs().flatMap((ref) => {
    const block = blocks.get(ref);
    if (!block) return [];
    return [
      {
        manifest: manifest({
          kind: 'step-block',
          id: `step-block.${block.name}`,
          version: block.version,
          contract: stepBlockContractVersion,
          title: blockRef(block),
          description: block.description,
          configSchema: z.toJSONSchema(block.params, { unrepresentable: 'any' }) as Record<
            string,
            unknown
          >,
        }),
        suite: stepBlockContract,
        target: async () => ({ subject: block }),
      } as PluginRegistration,
    ];
  }),
  ...engines.map((engine) => ({
    manifest: manifest({
      kind: 'knowledge',
      id: `knowledge.${engine.engine}`,
      version: '1',
      contract: 'knowledge@1',
      title: engine.title,
      description: engine.tech ?? '',
      capabilities: [...engine.capabilities],
      dataLocation: engine.dataLocation ?? null,
      configSchema: engine.endpointOptions ?? { type: 'object' },
    }),
  })),
  ...builtinHookPlugins(),
  {
    manifest: manifest({
      kind: 'hook',
      id: 'hook.webhook',
      version: '1',
      contract: hookContractVersion,
      title: 'Webhook',
      description: 'Sends the hook call as a signed POST and reads the verdict from the answer.',
      capabilities: ['observe', 'annotate', 'enforce'],
      configSchema: {
        type: 'object',
        required: ['url', 'secret'],
        properties: { url: { type: 'string', format: 'uri' }, secret: { type: 'string' } },
      },
      secrets: ['secret'],
    }),
    suite: hookContract,
    target: webhookHookTarget,
  } as PluginRegistration,
];

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const summary = (entry: PluginEntry) => ({
  ...entry.manifest,
  verifiable: entry.verifiable,
  contractTests: entry.latest
    ? {
        passed: entry.latest.passed,
        version: entry.latest.version,
        at: entry.latest.endedAt,
        trigger: entry.latest.trigger,
        results: entry.latest.results,
      }
    : null,
  history: entry.history,
});

export const pluginsModule: PlatformModuleFactory = (deps) => {
  const registry = deps.pluginRegistry;
  const runtime = deps.externalPlugins?.runtime;
  const external =
    registry &&
    externalPlugins(
      deps.configEntries,
      registry,
      deps.externalPlugins?.target ?? (() => undefined),
      runtime ? { ...runtime, platformTenant: deps.platformTenant } : undefined,
    );
  const synced = async () => {
    await external?.sync();
  };
  void synced().catch(() => undefined);
  deps.onChange('config-entries', synced);
  const tools = deps.externalPlugins?.tools;

  const connectTools = async (plugin: ExternalPlugin, enabled: boolean) => {
    const { manifest: m, endpoint } = plugin;
    if (m.kind !== 'tool-source' || !endpoint || !tools) return;
    const id = pluginConnectionId(m.id);
    const tenant = deps.platformTenant;
    const before = await deps.connections.get(tenant, id);
    await deps.connections.save({
      connection: {
        id,
        tenant,
        name: m.title,
        protocol: endpoint.protocol as 'mcp' | 'a2a' | 'openapi',
        endpoint: endpoint.baseURL,
        version: m.version.split('.')[0] ?? '1',
        allow: endpoint.allow ?? manifestAllow(m, endpoint.baseURL),
        ...(endpoint.document ? { document: endpoint.document } : {}),
        ...(endpoint.auth && tenantSecretPattern.test(endpoint.auth.secret)
          ? { auth: { kind: 'bearer', secret: endpoint.auth.secret } }
          : {}),
      },
      tools: enabled ? (before?.tools ?? []) : [],
      pending: enabled ? (before?.pending ?? []) : [],
    });
    if (enabled) await tools.source.sync(tenant, id);
    await tools.source.load(tenant);
    await tools.changed(tenant);
  };

  const contractErrors = (run: ContractRun) =>
    run.results
      .filter((r) => r.status === 'failed')
      .map((r) => ({ path: `contract.${r.name}`, message: r.reason ?? 'failed' }));
  const isOperator = (principal: { kind: string; actor?: { kind: string } }) =>
    principal.kind === 'operator' || principal.actor?.kind === 'operator';

  const handlers: Record<string, AdminHandler> = {
    'platform.plugin.register': async (input, principal) => {
      const plugin = input.plugin as ExternalPlugin;
      const id = plugin.manifest.id;
      const target = `plugin:${id}`;
      if (!isOperator(principal))
        return { ok: false, errors: [{ path: 'principal', message: 'operators only' }], target };
      if (!registry || !external)
        return { ok: false, errors: [{ path: 'plugin', message: 'no plug-in registry' }], target };
      await synced();
      const before = await external.find(id);
      if (!before && registry.get(id))
        return {
          ok: false,
          errors: [{ path: 'manifest.id', message: `${id} is a built-in plug-in` }],
          target,
          conflict: true,
        };
      const by = actorOf(principal.actor ?? principal);
      const run = await registry.admit(external.registrationOf(plugin), { by });
      if (run && !run.passed)
        return {
          ok: false,
          errors: contractErrors(run),
          target,
          audit: { refused: plugin, contractTests: run.results },
        };
      const saved = await external.save(plugin, by, String(input.reason ?? ''));
      await connectTools(plugin, true);
      await deps.catalog.refresh();
      return {
        ok: true,
        value: {
          ...plugin.manifest,
          version: plugin.manifest.version,
          revision: saved.version,
          contractTests: run ? { passed: run.passed, results: run.results } : null,
        },
        target,
        audit: { before: before ?? null, after: plugin },
      };
    },
    'platform.plugin.remove': async (input, principal) => {
      const id = String(input.plugin ?? '');
      const target = `plugin:${id}`;
      if (!isOperator(principal))
        return { ok: false, errors: [{ path: 'principal', message: 'operators only' }], target };
      const before = await external?.find(id);
      if (!before || !external)
        return {
          ok: false,
          errors: [{ path: 'plugin', message: `no external plug-in ${id}` }],
          target,
        };
      await external.save(
        before,
        actorOf(principal.actor ?? principal),
        String(input.reason ?? ''),
        true,
      );
      await connectTools(before, false);
      await deps.catalog.refresh();
      return { ok: true, value: { removed: id }, target, audit: { before } };
    },
    'platform.plugin.promote': async (input, principal) => {
      const owner = String(input.owner ?? '');
      const connection = String(input.connection ?? '');
      const target = `tool-connection:${owner}/${connection}`;
      if (!isOperator(principal))
        return { ok: false, errors: [{ path: 'principal', message: 'operators only' }], target };
      if (!registry || !external)
        return { ok: false, errors: [{ path: 'plugin', message: 'no plug-in registry' }], target };
      const state = await deps.connections.get(owner, connection);
      if (!state)
        return {
          ok: false,
          errors: [{ path: 'plugin', message: `no tool connection ${connection} for ${owner}` }],
          target,
        };
      if (state.tools.length === 0)
        return {
          ok: false,
          errors: [{ path: 'connection', message: 'the connection has no approved tools' }],
          target,
        };
      await synced();
      const taken = (await external.plugins()).find(
        (p) =>
          (p.shared?.connection ?? pluginConnectionId(p.manifest.id)) === connection &&
          p.shared?.tenant !== owner,
      );
      if (taken || (owner !== deps.platformTenant && runtime?.sharedTools.get(connection)))
        return {
          ok: false,
          errors: [
            {
              path: 'manifest.id',
              message: `another shared plug-in already offers tools named ${connection}.*`,
            },
          ],
          target,
          conflict: true,
        };
      const id = `tool-source.${owner}.${connection}`;
      const plugin: ExternalPlugin = {
        manifest: manifest({
          kind: 'tool-source',
          id,
          version: state.connection.version,
          contract: toolSourceContractVersion,
          title: state.connection.name,
          description: `Tools from ${connection}, published by ${owner} and shared by Digdir.`,
          publisher: owner,
          origin: 'external',
          hosts: state.connection.allow.map((a) => (a.port ? `${a.host}:${a.port}` : a.host)),
          secrets: state.connection.auth ? [state.connection.auth.secret] : [],
        }),
        shared: { tenant: owner, connection },
      };
      const before = await external.find(id);
      const saved = await external.save(
        plugin,
        actorOf(principal.actor ?? principal),
        String(input.reason ?? ''),
      );
      return {
        ok: true,
        value: { ...plugin.manifest, revision: saved.version, shared: plugin.shared },
        target,
        audit: { before: before ?? null, after: plugin },
      };
    },
    'platform.plugin.verify': async (input, principal) => {
      const id = String(input.plugin ?? '');
      const target = `plugin:${id}`;
      if (principal.kind !== 'operator' && principal.actor?.kind !== 'operator')
        return { ok: false, errors: [{ path: 'principal', message: 'operators only' }], target };
      if (!registry)
        return { ok: false, errors: [{ path: 'plugin', message: 'no plug-in registry' }], target };
      await synced();
      try {
        const run = await registry.verify(id, {
          trigger: 'operator',
          by: actorOf(principal.actor ?? principal),
        });
        return {
          ok: true,
          value: run,
          target,
          audit: { after: { passed: run.passed, version: run.version } },
        };
      } catch (error) {
        if (error instanceof PluginError)
          return {
            ok: false,
            errors: [
              { path: error.code === 'not_found' ? 'plugin' : 'suite', message: error.message },
            ],
            target,
          };
        throw error;
      }
    },
  };

  const adopted = async (tenant: string, block: PluginBlock) => {
    const latest = (
      await deps.configEntries.history(adoptionKind, tenant, blockKey(block.kind, block.id))
    ).at(-1);
    return Boolean(
      latest && !latest.deleted && (latest.spec as { status?: string }).status === 'in_use',
    );
  };

  const checkPublish = async (definition: unknown) => {
    const d = definition as { kind?: string; metadata?: { tenant?: string }; spec?: ServiceSpec };
    const tenant = d.metadata?.tenant;
    if (d.kind !== 'Service' || !tenant || !d.spec || !external) return [];
    const spec = d.spec;
    const plugins = await external.plugins();
    const byId = new Map(plugins.map((p) => [p.manifest.id, p]));
    const byConnection = new Map(
      plugins.flatMap((p) => {
        const block = pluginBlockOf(p);
        return block?.kind === 'tool' ? [[block.id, p] as const] : [];
      }),
    );
    const used: { path: string; plugin: ExternalPlugin }[] = [];
    const models = [spec.model, ...(spec.variants ?? []).map((v) => v.model)].flatMap((m) =>
      m
        ? Object.values(m).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v ?? {})))
        : [],
    );
    for (const id of models) {
      const plugin = byId.get(String(id));
      if (plugin) used.push({ path: 'spec.model', plugin });
    }
    for (const d of spec.knowledge?.datasets ?? []) {
      const plugin = byId.get(d.dataset ?? '');
      if (plugin) used.push({ path: 'spec.knowledge.datasets', plugin });
    }
    const reranker = spec.knowledge?.reranker && byId.get(spec.knowledge.reranker);
    if (reranker) used.push({ path: 'spec.knowledge.reranker', plugin: reranker });
    for (const tool of spec.tools ?? []) {
      const ref = typeof tool === 'string' ? tool : (tool.use ?? '');
      const plugin = byConnection.get(ref.slice(0, Math.max(ref.indexOf('.'), 0)));
      const owner = plugin?.shared?.tenant ?? deps.platformTenant;
      if (plugin && owner !== tenant) used.push({ path: 'spec.tools', plugin });
    }
    const errors: { path: string; message: string }[] = [];
    const engines = [
      { strategy: spec.strategy, path: 'spec.strategy.config.agent' },
      ...(spec.variants ?? []).map((v, i) => ({
        strategy: v.strategy,
        path: `spec.variants[${i}].strategy.config.agent`,
      })),
    ];
    for (const { strategy, path } of engines) {
      const agent = strategy?.id === 'remote-agent' ? strategy.config?.agent : undefined;
      if (typeof agent !== 'string') continue;
      const plugin = byId.get(agent);
      if (!plugin || !agentEndpointOf(plugin, deps.platformTenant))
        errors.push({ path, message: `no registered engine plug-in ${agent}` });
      else used.push({ path, plugin });
    }
    for (const { path, plugin } of used) {
      const block = pluginBlockOf(plugin);
      if (block && !(await adopted(tenant, block)))
        errors.push({
          path,
          message: `${plugin.manifest.id} is offered by Digdir but ${tenant} has not adopted it`,
        });
    }
    return errors;
  };

  return {
    id: 'plugins',
    handlers,
    checkPublish,
    mount: (app, mounted) => {
      const operator = async (c: Context) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Unauthorized') };
        if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
        return { principal: { ...principal, tenant: deps.platformTenant } };
      };
      const kindOf = (c: Context) => {
        const kind = c.req.query('kind');
        return kind ? (kind as Parameters<PluginRegistry['list']>[0]) : undefined;
      };

      const changed = async (
        c: Context,
        principal: Principal,
        action: 'platform.plugin.register' | 'platform.plugin.remove' | 'platform.plugin.promote',
        data: Record<string, unknown>,
      ) => {
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        const result = await mounted.admin.perform(principal, action, {
          ...data,
          tenant: deps.platformTenant,
          reason,
        });
        c.header('genai-task', result.task);
        if (result.ok)
          return c.json(result.value as object, action === 'platform.plugin.remove' ? 200 : 201);
        const paths = new Set(result.errors.map((e) => e.path));
        if (paths.has('principal')) return problem(c, 403, 'Forbidden', result.errors);
        if (paths.has('plugin')) return problem(c, 404, 'Not found', result.errors);
        if (paths.has('manifest.id')) return problem(c, 409, 'Conflict', result.errors);
        if (result.errors.some((e) => e.path.startsWith('contract.')))
          return problem(c, 422, 'The contract tests failed', result.errors);
        return problem(c, 400, 'Invalid request', result.errors);
      };

      app.post('/operator/plugins', async (c) => {
        const who = await operator(c);
        if (who.response) return who.response;
        const checked = checkExternalPlugin(
          await c.req.json().catch(() => undefined),
          deps.externalPlugins?.protocols ?? {},
        );
        if (!checked.ok)
          return problem(
            c,
            checked.status,
            checked.status === 422 ? 'This kind is not registered here' : 'Invalid plug-in',
            checked.errors,
          );
        return changed(c, who.principal, 'platform.plugin.register', { plugin: checked.plugin });
      });

      app.post('/operator/plugins/promotions', async (c) => {
        const who = await operator(c);
        if (who.response) return who.response;
        const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
        if (typeof body.tenant !== 'string' || typeof body.connection !== 'string')
          return problem(c, 400, 'Invalid request', [
            { path: 'tenant', message: 'name the tenant and the tool connection to promote' },
          ]);
        return changed(c, who.principal, 'platform.plugin.promote', {
          owner: body.tenant,
          connection: body.connection,
        });
      });

      app.delete('/operator/plugins/:id', async (c) => {
        const who = await operator(c);
        if (who.response) return who.response;
        return changed(c, who.principal, 'platform.plugin.remove', { plugin: c.req.param('id') });
      });

      app.get('/operator/plugins', async (c) => {
        const who = await operator(c);
        if (who.response) return who.response;
        await synced();
        return c.json({ data: (await registry?.list(kindOf(c)))?.map(summary) ?? [] });
      });

      app.get('/operator/plugins/:id', async (c) => {
        const who = await operator(c);
        if (who.response) return who.response;
        const id = c.req.param('id') ?? '';
        await synced();
        const entry = await registry?.describe(id);
        if (!entry || !registry) return problem(c, 404, 'Not found');
        return c.json({ ...summary(entry), runs: await registry.runs.list(id) });
      });

      app.post('/operator/plugins/manifest-check', async (c) => {
        const who = await operator(c);
        if (who.response) return who.response;
        const parsed = parseManifest(await c.req.json().catch(() => undefined));
        return parsed.ok
          ? c.json(parsed.manifest)
          : problem(c, 400, 'Invalid manifest', parsed.errors);
      });

      const verify = async (c: Context) => {
        const who = await operator(c);
        if (who.response) return who.response;
        const plugin = c.req.param('id') ?? '';
        const result = await mounted.admin.perform(who.principal, 'platform.plugin.verify', {
          tenant: deps.platformTenant,
          plugin,
          reason: changeReasonOf(c)?.trim() ?? '',
        });
        c.header('genai-task', result.task);
        if (result.ok) return c.json(result.value as object, 200);
        const paths = new Set(result.errors.map((e) => e.path));
        if (paths.has('plugin')) return problem(c, 404, 'Not found', result.errors);
        if (paths.has('principal')) return problem(c, 403, 'Forbidden', result.errors);
        return problem(c, 409, 'Conflict', result.errors);
      };
      app.post('/operator/plugins/:id/contract-tests', verify);
      app.post('/operator/building-blocks/:id/contract-tests', verify);

      app.get('/tenants/:tenant/plugins', async (c) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, 'Unauthorized');
        const entered = enterTenant(
          c,
          mounted.access,
          principal,
          c.req.param('tenant') ?? '',
          'use-services',
        );
        if ('response' in entered) return entered.response;
        await synced();
        return c.json({
          data: ((await registry?.list(kindOf(c))) ?? []).map((entry) => ({
            kind: entry.manifest.kind,
            id: entry.manifest.id,
            version: entry.manifest.version,
            contract: entry.manifest.contract,
            title: pluginTitle(entry.manifest.id, entry.manifest.title),
            description: entry.manifest.description,
            publisher: entry.manifest.publisher,
            capabilities: entry.manifest.capabilities,
            dataLocation: entry.manifest.dataLocation,
            contractTests: entry.latest
              ? { passed: entry.latest.passed, at: entry.latest.endedAt }
              : null,
          })),
        });
      });
    },
  };
};
