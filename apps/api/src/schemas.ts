import { createHash } from 'node:crypto';
import { createRoute, z as zo, type RouteConfig } from '@hono/zod-openapi';
import {
  annotateSchema,
  localizeSchema,
  type PropertyMeta,
  type SchemaLabels,
  type SchemaLocale,
  type UiText,
} from '@genai/contracts';
import { catalogPrice, priceSchemaLabels } from '@genai/composition';
import {
  commonSchemaLabels,
  inputFieldSchemaLabels,
  jsonSchemaOf,
  outputSchemaLabels,
  serviceDefinition,
  serviceSchemaLabels,
  serviceSpec,
  settingSchemaLabels,
  settingsSchema,
  skillDefinition,
  skillSchemaLabels,
  stepFlowDefinition,
  stepFlowSchemaLabels,
  triggerSchemaLabels,
  type PluginSchemas,
  type SettingDefinition,
} from '@genai/definitions';
import { guardrailSchemaLabels } from '@genai/guardrails';
import { negotiate } from '@genai/i18n';
import { pluginManifest, pluginManifestSchemaLabels, type PluginManifest } from '@genai/plugins';
import { embeddingCatalog, embeddingCatalogSchemaLabels } from '@genai/port-embedding';
import { knowledgeCatalog, knowledgeCatalogSchemaLabels } from '@genai/port-knowledge';
import { instructionSchemaLabels, modelCatalog, modelCatalogSchemaLabels } from '@genai/port-model';
import { rerankCatalog, rerankCatalogSchemaLabels } from '@genai/port-rerank';
import { connectionInput, toolConnectionSchemaLabels } from '@genai/providers-mcp-client';
import { agentLoopSchemaLabels } from '@genai/strategy-agent-loop';
import { platformServiceSchemaLabels } from '@genai/strategy-builder';
import { ragSchemaLabels } from '@genai/strategy-rag';
import { remoteAgentSchemaLabels } from '@genai/strategy-remote';
import { singleCallSchemaLabels } from '@genai/strategy-single-call';
import {
  blockSchemaLabels,
  builtinBlocks,
  stepFlowConfigSchemaLabels,
  type BlockRegistry,
} from '@genai/strategy-step-flow';
import type { Context } from 'hono';
import type { z } from 'zod';
import { v1ErrorContent } from './frontend-openapi.js';
import { problemContent } from './http.js';
import { t } from './i18n/index.js';
import type { PlatformModuleFactory } from './platform-modules.js';

type Json = Record<string, unknown>;

export const definitionVersion = 'v1';
export const definitionApiVersion = 'genai/v1';

export interface SchemaUse {
  kind: string;
  version: string;
  at: string;
  when?: { field: string; equals: unknown };
}

export interface SchemaEntry {
  kind: string;
  version: string;
  title: UiText;
  labels: SchemaLabels[];
  source: () => Json;
  right?: string;
  operator?: boolean;
  uses?: SchemaUse[];
  listed: boolean;
}

export interface SchemaSources {
  plugins: Pick<PluginSchemas, 'strategies' | 'guardrails'>;
  settings: SettingDefinition[];
  blocks?: BlockRegistry;
  manifests?: PluginManifest[];
}

const element = (schema: z.ZodType): z.ZodType => {
  let current = schema as unknown as {
    unwrap?: () => z.ZodType;
    element?: z.ZodType;
    valueType?: z.ZodType;
  };
  while (current.unwrap && !current.element && !current.valueType)
    current = current.unwrap() as unknown as typeof current;
  return (current.element ?? current.valueType ?? schema) as z.ZodType;
};

const shapeOf = (schema: z.ZodType, key: string) =>
  (schema as unknown as { shape: Record<string, z.ZodType> }).shape[key] as z.ZodType;

const fromZod = (schema: z.ZodType) => () => jsonSchemaOf(schema);

const strategyLabels: Record<string, SchemaLabels> = {
  'single-call': singleCallSchemaLabels,
  'agent-loop': agentLoopSchemaLabels,
  'rag-single-shot': ragSchemaLabels,
  'step-flow': stepFlowConfigSchemaLabels,
  'remote-agent': remoteAgentSchemaLabels,
  'builder-assistant': platformServiceSchemaLabels,
  optimiser: platformServiceSchemaLabels,
};

const text = (nb: string, en: string): UiText => ({ nb, en });

export const strategyTitle = (id: string): UiText | undefined => strategyLabels[id]?.titles?.[id];

const titleOf = (labels: SchemaLabels, id: string, fallback: string): UiText =>
  labels.titles?.[id] ?? text(fallback, fallback);

const splitRef = (ref: string) => {
  const at = ref.lastIndexOf('@');
  return at < 0 ? { id: ref, version: '' } : { id: ref.slice(0, at), version: ref.slice(at + 1) };
};

const endpointLabels = [modelCatalogSchemaLabels, commonSchemaLabels];

export const schemaEntries = (sources: SchemaSources): SchemaEntry[] => {
  const blocks = sources.blocks ?? builtinBlocks();
  const strategies = [...sources.plugins.strategies].map(([key, schema]) => {
    const { id, version } = splitRef(key);
    const labels = strategyLabels[id];
    return {
      kind: `Strategy.${id}`,
      version,
      title: labels ? titleOf(labels, id, id) : text(id, id),
      labels: [...(labels ? [labels] : []), instructionSchemaLabels, commonSchemaLabels],
      source: fromZod(schema),
      right: 'manage-services',
      listed: false,
      id,
    };
  });
  const guardrails = [...sources.plugins.guardrails].map(([id, schema]) => ({
    kind: `Guardrail.${id}`,
    version: definitionVersion,
    title: titleOf(guardrailSchemaLabels, id, id),
    labels: [guardrailSchemaLabels, commonSchemaLabels],
    source: fromZod(schema),
    right: 'manage-services',
    listed: false,
    id,
  }));
  const blockEntries = blocks.refs().flatMap((ref) => {
    const block = blocks.get(ref);
    if (!block) return [];
    return [
      {
        kind: `Block.${block.name}`,
        version: String(block.version),
        title: titleOf(blockSchemaLabels, block.name, block.name),
        labels: [blockSchemaLabels, instructionSchemaLabels, commonSchemaLabels],
        source: fromZod(block.params),
        right: 'manage-services',
        listed: false,
        id: block.name,
      },
    ];
  });
  const plugins = (sources.manifests ?? [])
    .filter((m) => m.kind !== 'step-block' && Object.keys(m.configSchema.properties ?? {}).length)
    .map((m) => ({
      kind: `Plugin.${m.id}`,
      version: m.version,
      title: text(m.title, m.title),
      labels: [pluginManifestSchemaLabels, commonSchemaLabels],
      source: () => ({ ...m.configSchema }),
      operator: true,
      listed: false,
      id: m.id,
    }));
  const use = (entry: { kind: string; version: string }, at: string, when?: SchemaUse['when']) => ({
    kind: entry.kind,
    version: entry.version,
    at,
    ...(when ? { when } : {}),
  });
  const top = (
    kind: string,
    title: UiText,
    schema: z.ZodType | (() => Json),
    labels: SchemaLabels[],
    access: { right?: string; operator?: boolean },
    uses?: SchemaUse[],
  ): SchemaEntry => ({
    kind,
    version: definitionVersion,
    title,
    labels: [...labels, commonSchemaLabels],
    source: typeof schema === 'function' ? schema : fromZod(schema),
    ...access,
    ...(uses ? { uses } : {}),
    listed: true,
  });
  const services = { right: 'manage-services' };
  const datasets = { right: 'manage-datasets' };
  const operator = { operator: true };
  const strip = <T extends { id?: string }>({ id: _id, ...rest }: T) => rest;
  const strategyChoices: SchemaLabels = {
    nb: {},
    en: {},
    meta: {
      'strategy.id': {
        'x-widget': 'select',
        'x-options': { enum: [...new Set(strategies.map((s) => s.id))] },
      },
    },
  };
  return [
    top(
      'Service',
      text('Tjeneste', 'Service'),
      serviceDefinition,
      [serviceSchemaLabels, strategyChoices],
      services,
      [
        ...strategies.map((s) =>
          use(s, 'spec.strategy.config', { field: 'spec.strategy.id', equals: s.id }),
        ),
        ...guardrails.map((g) => use(g, `spec.guardrails.${g.id}`)),
        use({ kind: 'Settings', version: definitionVersion }, 'spec.settings'),
        use({ kind: 'InputField', version: definitionVersion }, 'spec.input.fields'),
        use({ kind: 'Output', version: definitionVersion }, 'spec.output'),
        use({ kind: 'Trigger', version: definitionVersion }, 'spec.triggers'),
      ],
    ),
    top(
      'StepFlow',
      text('Stegflyt', 'Step flow'),
      stepFlowDefinition,
      [stepFlowSchemaLabels],
      services,
      blockEntries.map((b) =>
        use(b, 'spec.steps.params', { field: 'block', equals: `${b.id}@${b.version}` }),
      ),
    ),
    top('Skill', text('Ferdighet', 'Skill'), skillDefinition, [skillSchemaLabels], services),
    top(
      'Settings',
      text('Innstillinger', 'Settings'),
      () => settingsSchema(sources.settings),
      [settingSchemaLabels],
      {},
    ),
    top(
      'InputField',
      text('Skjemafelt', 'Form field'),
      element(shapeOf(shapeOf(serviceSpec, 'input'), 'fields')),
      [inputFieldSchemaLabels],
      services,
    ),
    top(
      'Output',
      text('Resultat', 'Output'),
      shapeOf(serviceSpec, 'output'),
      [outputSchemaLabels],
      services,
    ),
    top(
      'Trigger',
      text('Utløser', 'Trigger'),
      element(shapeOf(serviceSpec, 'triggers')),
      [triggerSchemaLabels],
      services,
    ),
    top(
      'ToolConnection',
      text('Verktøykobling', 'Tool connection'),
      connectionInput,
      [toolConnectionSchemaLabels],
      { right: 'register-building-blocks' },
    ),
    top(
      'PluginManifest',
      text('Plug-in', 'Plug-in'),
      pluginManifest,
      [pluginManifestSchemaLabels],
      operator,
      plugins.map((p) => use(p, 'configSchema', { field: 'id', equals: p.id })),
    ),
    top(
      'Model',
      text('Modell', 'Model'),
      element(shapeOf(modelCatalog, 'models')),
      [modelCatalogSchemaLabels],
      operator,
    ),
    top(
      'ModelEndpoint',
      text('Modellendepunkt', 'Model endpoint'),
      element(shapeOf(modelCatalog, 'endpoints')),
      [modelCatalogSchemaLabels],
      operator,
    ),
    top(
      'Dataset',
      text('Datasett', 'Dataset'),
      element(shapeOf(knowledgeCatalog, 'datasets')),
      [knowledgeCatalogSchemaLabels, ...endpointLabels],
      datasets,
    ),
    top(
      'KnowledgeEndpoint',
      text('Søkemotor', 'Search engine'),
      element(shapeOf(knowledgeCatalog, 'endpoints')),
      [knowledgeCatalogSchemaLabels, ...endpointLabels],
      datasets,
    ),
    top(
      'Reranker',
      text('Omrangering', 'Reranker'),
      element(shapeOf(rerankCatalog, 'rerankers')),
      [rerankCatalogSchemaLabels, ...endpointLabels],
      operator,
    ),
    top(
      'RerankEndpoint',
      text('Endepunkt for omrangering', 'Rerank endpoint'),
      element(shapeOf(rerankCatalog, 'endpoints')),
      [rerankCatalogSchemaLabels, ...endpointLabels],
      operator,
    ),
    top(
      'Embedding',
      text('Innbyggingsmodell', 'Embedding model'),
      element(shapeOf(embeddingCatalog, 'models')),
      [embeddingCatalogSchemaLabels, ...endpointLabels],
      operator,
    ),
    top(
      'EmbeddingEndpoint',
      text('Endepunkt for innbygging', 'Embedding endpoint'),
      element(shapeOf(embeddingCatalog, 'endpoints')),
      [embeddingCatalogSchemaLabels, ...endpointLabels],
      operator,
    ),
    top('Price', text('Pris', 'Price'), catalogPrice, [priceSchemaLabels], operator),
    ...[...strategies, ...guardrails, ...blockEntries, ...plugins].map(strip),
  ];
};

const withAccess = (schema: Json, entry: SchemaEntry): Json => {
  const access: PropertyMeta = {
    ...(entry.right ? { 'x-right': entry.right } : {}),
    ...(entry.operator ? { 'x-operator': true } : {}),
  };
  const properties = (schema.properties ?? {}) as Record<string, Json>;
  return {
    ...schema,
    ...access,
    ...(schema.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([k, v]) => [
              k,
              v['x-right'] || v['x-operator'] ? v : { ...v, ...access },
            ]),
          ),
        }
      : {}),
  };
};

export const refOf = (entry: Pick<SchemaEntry, 'kind' | 'version'>) =>
  `${entry.kind}@${entry.version}`;

export const servedSchema = (entry: SchemaEntry): Json => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...withAccess(annotateSchema(entry.source(), entry.labels), entry),
  $id: `/schemas/${refOf(entry)}`,
  'x-label': entry.title,
  ...(entry.listed ? { 'x-apiVersion': definitionApiVersion } : {}),
});

const listing = (entries: SchemaEntry[], locale: SchemaLocale | undefined) => {
  const title = (text: UiText | undefined) => (locale && text ? text[locale] : text);
  const byRef = new Map(entries.map((e) => [refOf(e), e]));
  const link = (ref: string) => `/schemas/${encodeURIComponent(ref)}`;
  return entries
    .filter((e) => e.listed)
    .map((e) => ({
      kind: e.kind,
      version: e.version,
      apiVersion: definitionApiVersion,
      title: title(e.title),
      href: link(refOf(e)),
      uses: (e.uses ?? [])
        .filter((u) => byRef.has(refOf(u)))
        .map((u) => ({ ...u, title: title(byRef.get(refOf(u))?.title), href: link(refOf(u)) })),
    }));
};

const etagOf = (body: string) =>
  `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;

const SchemaUseView = zo.object({
  kind: zo.string(),
  version: zo.string(),
  at: zo.string(),
  title: zo.unknown(),
  href: zo.string(),
  when: zo.object({ field: zo.string(), equals: zo.unknown() }).optional(),
});

const SchemaListing = zo
  .object({
    data: zo.array(
      zo.object({
        kind: zo.string(),
        version: zo.string(),
        apiVersion: zo.string(),
        title: zo.unknown(),
        href: zo.string(),
        uses: zo.array(SchemaUseView),
      }),
    ),
  })
  .openapi('SchemaListing');

const language = zo.object({
  'accept-language': zo
    .string()
    .optional()
    .openapi({ param: { name: 'accept-language', in: 'header' }, example: 'nb' }),
});

export const schemaRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/schemas',
    summary: 'List the published configuration schemas, with the schemas each kind uses',
    request: { headers: language },
    responses: {
      200: { content: { 'application/json': { schema: SchemaListing } }, description: 'Kinds' },
      401: { content: problemContent, description: 'Not signed in' },
    },
  }),
  createRoute({
    method: 'get',
    path: '/schemas/{ref}',
    summary: 'One schema as JSON Schema 2020-12 with UI metadata (x- keywords)',
    request: {
      params: zo.object({
        ref: zo.string().openapi({ param: { name: 'ref', in: 'path' }, example: 'Service@v1' }),
      }),
      headers: language,
    },
    responses: {
      200: {
        content: { 'application/schema+json': { schema: zo.record(zo.string(), zo.unknown()) } },
        description: 'Schema; texts in one language when Accept-Language names one',
      },
      304: { description: 'Not modified' },
      401: { content: problemContent, description: 'Not signed in' },
      404: { content: problemContent, description: 'No such schema' },
    },
  }),
  createRoute({
    method: 'get',
    path: '/v1/models/{id}/schema',
    summary:
      'The input form and the output shape of one service as JSON Schema 2020-12 with UI metadata',
    request: {
      params: zo.object({
        id: zo.string().openapi({
          param: { name: 'id', in: 'path' },
          example: 'kunnskapsassistenten__default',
        }),
      }),
      headers: language,
    },
    responses: {
      200: {
        content: { 'application/json': { schema: zo.record(zo.string(), zo.unknown()) } },
        description:
          'Object with `input` (validates `input` in POST /v1/chat/completions) and `output` schemas; texts in one language when Accept-Language names one',
      },
      401: { content: v1ErrorContent, description: 'Invalid or missing credentials' },
      404: { content: v1ErrorContent, description: 'No such service for this credential' },
    },
  }),
];

const notFound = (c: Context) =>
  c.json({ type: 'about:blank', title: t('problems.notFound'), status: 404 }, 404, {
    'content-type': 'application/problem+json',
  });

export const schemasModule: PlatformModuleFactory = () => ({
  id: 'schemas',
  mount: (app, deps) => {
    const registry = (app as { openAPIRegistry?: { registerPath(r: RouteConfig): void } })
      .openAPIRegistry;
    if (registry) for (const route of schemaRoutes) registry.registerPath(route);
    let cached: { entries: SchemaEntry[]; bodies: Map<string, Json> } | undefined;
    let seenPlugins = -1;
    const current = () => {
      const manifests = deps.pluginRegistry?.manifests() ?? [];
      if (!cached || manifests.length !== seenPlugins) {
        seenPlugins = manifests.length;
        cached = {
          entries: schemaEntries({
            plugins: deps.plugins,
            settings: deps.settings.definitions(),
            manifests,
          }),
          bodies: new Map(),
        };
      }
      return cached;
    };
    const signedIn = async (c: Context) => {
      if (await deps.authenticate(c.req.raw)) return undefined;
      return c.json({ type: 'about:blank', title: t('problems.notSignedIn'), status: 401 }, 401, {
        'content-type': 'application/problem+json',
      });
    };
    const localized = (c: Context, body: unknown) => {
      const locale = negotiate(c.req.header('accept-language'));
      return locale ? localizeSchema(body, locale) : body;
    };
    const send = (c: Context, body: unknown, type: string) => {
      const text = JSON.stringify(body);
      const etag = etagOf(text);
      const headers = { etag, vary: 'Accept-Language', 'content-type': type };
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
      return c.body(text, 200, headers);
    };
    app.get('/schemas', async (c) => {
      const refused = await signedIn(c);
      if (refused) return refused;
      const locale = negotiate(c.req.header('accept-language'));
      return send(c, { data: listing(current().entries, locale) }, 'application/json');
    });
    app.get('/schemas/:ref', async (c) => {
      const refused = await signedIn(c);
      if (refused) return refused;
      const ref = decodeURIComponent(c.req.param('ref') ?? '');
      const { entries, bodies } = current();
      const entry = entries.find((e) => refOf(e) === ref);
      if (!entry) return notFound(c);
      const body = bodies.get(ref) ?? servedSchema(entry);
      bodies.set(ref, body);
      return send(c, localized(c, body), 'application/schema+json');
    });
  },
});
