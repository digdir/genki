import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { isSchemaWidget, missingLabels, schemaProperties, type Principal } from '@genai/contracts';
import {
  platformSettings,
  serviceDefinition,
  skillDefinition,
  stepFlowDefinition,
} from '@genai/definitions';
import { guardrailSchemas } from '@genai/guardrails';
import { isPlatformRight } from '@genai/identity';
import { embeddingCatalog } from '@genai/port-embedding';
import { knowledgeCatalog } from '@genai/port-knowledge';
import { modelCatalog } from '@genai/port-model';
import { rerankCatalog } from '@genai/port-rerank';
import { builtinBlocks } from '@genai/strategy-step-flow';
import { openApiPath } from './openapi-routes.js';
import { bootPlatform, digdir } from './testkit.js';

type Json = Record<string, unknown>;

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
};

const boot = () => bootPlatform({ people });

interface Listing {
  data: {
    kind: string;
    version: string;
    href: string;
    title: unknown;
    uses: { kind: string; version: string; href: string; at: string }[];
  }[];
}

const served = async () => {
  const { send, app, platform } = await boot();
  const listing = (await (await send('/schemas', 'kari')).json()) as Listing;
  const hrefs = [...new Set(listing.data.flatMap((e) => [e.href, ...e.uses.map((u) => u.href)]))];
  const schemas = new Map<string, Json>();
  for (const href of hrefs) {
    const res = await send(href, 'kari');
    expect(res.status, href).toBe(200);
    schemas.set(decodeURIComponent(href.slice('/schemas/'.length)), (await res.json()) as Json);
  }
  return { send, app, platform, listing, schemas };
};

const repo = join(import.meta.dirname, '..', '..', '..');
const local = join(repo, 'apps', 'api', 'config', 'local');

const yamlFiles = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => ({ file: join(dir, f), value: parseYaml(readFileSync(join(dir, f), 'utf8')) }));

const filled = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value).replace(/\$\{[A-Z0-9_]+\}/g, 'https://example.test')) as unknown;

const validator = (schema: Json) => {
  const rest = Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== '$schema' && key !== '$id'),
  );
  return new Ajv({ unknownFormats: 'ignore' }).compile(rest);
};

const agrees = (zod: z.ZodType, schema: Json, value: unknown, where: string) => {
  const byZod = zod.safeParse(value).success;
  const byJson = validator(schema)(value) as boolean;
  expect({ where, byJson }).toEqual({ where, byJson: byZod });
  return byZod;
};

describe('configuration schemas (ADR 0030)', () => {
  it('every property in every served schema has an x-label in bokmål and English', async () => {
    const { schemas } = await served();
    const missing = [...schemas].flatMap(([ref, schema]) =>
      missingLabels(schema).map((path) => `${ref}: ${path}`),
    );
    expect(missing).toEqual([]);
    expect(schemas.size).toBeGreaterThan(30);
  });

  it('every x-widget in a served schema is one of the widgets ADR 0030 lists', async () => {
    const { schemas } = await served();
    const unknown = [...schemas].flatMap(([ref, schema]) =>
      schemaProperties(schema)
        .filter(({ node }) => node['x-widget'] !== undefined && !isSchemaWidget(node['x-widget']))
        .map(({ path, node }) => `${ref}: ${path} ${String(node['x-widget'])}`),
    );
    expect(unknown).toEqual([]);
  });

  it('every x-options route in a served schema is a GET route in /openapi.json', async () => {
    const { schemas, send } = await served();
    const doc = (await (await send('/openapi.json', 'kari')).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const routes = [...schemas].flatMap(([ref, schema]) =>
      schemaProperties(schema).flatMap(({ path, node }) => {
        const options = node['x-options'] as { route?: string } | undefined;
        return options?.route ? [{ at: `${ref}: ${path}`, route: options.route }] : [];
      }),
    );
    expect(routes.length).toBeGreaterThan(5);
    const missing = routes.filter(({ route }) => !doc.paths[route.split('?')[0] ?? '']?.get);
    expect(missing).toEqual([]);
  });

  it('every x-right in a served schema is a platform right', async () => {
    const { schemas } = await served();
    const rights = [...schemas].flatMap(([ref, schema]) =>
      [schema, ...schemaProperties(schema).map((p) => p.node)].flatMap((node) =>
        node['x-right'] === undefined ? [] : [{ ref, right: node['x-right'] }],
      ),
    );
    expect(rights.length).toBeGreaterThan(0);
    expect(rights.filter(({ right }) => !isPlatformRight(String(right)))).toEqual([]);
  });

  it('every API route with a fixed path appears in /openapi.json', async () => {
    const { app, send } = await boot();
    const doc = (await (await send('/openapi.json', 'kari')).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const missing = app.routes
      .filter((r) => r.method !== 'ALL')
      .flatMap((r) => {
        const path = openApiPath(r.path);
        return path && !doc.paths[path]?.[r.method.toLowerCase()] ? [`${r.method} ${r.path}`] : [];
      });
    expect(missing).toEqual([]);
    expect(doc.paths['/schemas/{ref}']?.get).toMatchObject({ summary: expect.any(String) });
    expect(doc.paths['/v1/models/{id}/schema']?.get).toMatchObject({
      summary: expect.stringContaining('input form'),
    });
  });

  it('lists the strategy, guardrail and block schemas under the kind that uses them', async () => {
    const { listing } = await served();
    const service = listing.data.find((e) => e.kind === 'Service');
    const flow = listing.data.find((e) => e.kind === 'StepFlow');
    expect(service?.uses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'Strategy.agent-loop', at: 'spec.strategy.config' }),
        expect.objectContaining({ kind: 'Guardrail.language', at: 'spec.guardrails.language' }),
        expect.objectContaining({ kind: 'Settings', at: 'spec.settings' }),
      ]),
    );
    expect(flow?.uses).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'Block.retrieve', version: '1' })]),
    );
    expect(listing.data.map((e) => e.kind)).not.toContain('Strategy.agent-loop');
  });

  it('resolves x-label to the language Accept-Language names, and gives both without it', async () => {
    const { send } = await boot();
    const label = async (headers: Record<string, string>) => {
      const schema = (await (await send('/schemas/Service@v1', 'kari', { headers })).json()) as {
        properties: { spec: { properties: { purpose: { 'x-label': unknown } } } };
      };
      return schema.properties.spec.properties.purpose['x-label'];
    };
    expect(await label({ 'accept-language': 'en-GB,en;q=0.9' })).toBe('Purpose');
    expect(await label({ 'accept-language': 'nb-NO' })).toBe('Formål');
    expect(await label({})).toEqual({ nb: 'Formål', en: 'Purpose' });
  });

  it('answers a schema with an ETag, and with 304 when If-None-Match matches it', async () => {
    const { send } = await boot();
    const first = await send('/schemas/Settings@v1', 'kari');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^".+"$/);
    expect(first.headers.get('vary')).toContain('Accept-Language');
    const again = await send('/schemas/Settings@v1', 'kari', {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
  });

  it('serves schemas to any signed-in principal and to nobody else', async () => {
    const { send } = await boot();
    expect((await send('/schemas', 'nobody')).status).toBe(401);
    expect((await send('/schemas/Service@v1', 'kari')).status).toBe(200);
    expect((await send('/schemas/Service@v9', 'kari')).status).toBe(404);
  });

  it('marks settings with the layers that may set them and secrets as sensitive', async () => {
    const { send } = await boot();
    const schema = (await (await send('/schemas/Settings@v1', 'kari')).json()) as {
      properties: Record<string, Json>;
    };
    expect(schema.properties['answers.writtenStandard']).toMatchObject({
      'x-settableAt': ['platform', 'tenant', 'service', 'call'],
      'x-right': 'manage-services',
      'x-group': { nb: 'Svar', en: 'Answers' },
    });
    expect(schema.properties['assistant.model']).toMatchObject({ 'x-widget': 'model' });
  });

  it('a served schema accepts and rejects the same examples as the zod schema behind it', async () => {
    const { schemas } = await served();
    const schema = (ref: string) => schemas.get(ref) as Json;
    const definitions = [
      ...yamlFiles(join(repo, 'packages', 'definitions', 'examples')),
      ...yamlFiles(join(local, 'services')),
      ...yamlFiles(join(local, 'flows')),
    ];
    const kinds: Record<string, z.ZodType> = {
      Service: serviceDefinition,
      StepFlow: stepFlowDefinition,
      Skill: skillDefinition,
    };
    let accepted = 0;
    const blocks = builtinBlocks();
    for (const { file, value } of definitions) {
      const kind = (value as { kind: string }).kind;
      const zod = kinds[kind];
      if (!zod) continue;
      if (agrees(zod, schema(`${kind}@v1`), value, file)) accepted += 1;
      const broken = { ...(value as Json), surprise: true };
      expect(agrees(zod, schema(`${kind}@v1`), broken, `${file} with an unknown key`)).toBe(false);
      const spec = (value as { spec: Json }).spec;
      if (kind === 'Service') {
        for (const [id, config] of Object.entries((spec.guardrails ?? {}) as Json)) {
          const zodGuard = guardrailSchemas.get(id);
          if (zodGuard) agrees(zodGuard, schema(`Guardrail.${id}@v1`), config, `${file} ${id}`);
        }
      }
      if (kind === 'StepFlow')
        for (const step of spec.steps as { block?: string; params?: unknown }[]) {
          const block = step.block ? blocks.get(step.block) : undefined;
          if (block)
            agrees(
              block.params,
              schema(`Block.${block.name}@${block.version}`),
              step.params ?? {},
              `${file} ${step.block}`,
            );
        }
    }
    expect(accepted).toBeGreaterThan(20);

    const catalogue = (file: string) => filled(parseYaml(readFileSync(join(local, file), 'utf8')));
    const entries = (catalog: unknown, list: string): { endpoints: Json[]; items: Json[] } => {
      const c = catalog as Record<string, unknown>;
      return {
        endpoints: Object.values((c.endpoints ?? {}) as Record<string, Json>).map(
          ({ sharing: _sharing, ...rest }) => rest,
        ),
        items: (c[list] ?? []) as Json[],
      };
    };
    const element = (catalog: z.ZodType, key: string) => {
      const shape = (catalog as unknown as { shape: Record<string, z.ZodType> }).shape;
      let node = shape[key] as unknown as {
        unwrap?: () => unknown;
        element?: z.ZodType;
        valueType?: z.ZodType;
      };
      while (node.unwrap && !node.element && !node.valueType) node = node.unwrap() as typeof node;
      return (node.element ?? node.valueType) as z.ZodType;
    };
    const catalogs = [
      {
        file: 'models.yaml',
        zod: modelCatalog,
        list: 'models',
        item: 'Model',
        endpoint: 'ModelEndpoint',
      },
      {
        file: 'knowledge.yaml',
        zod: knowledgeCatalog,
        list: 'datasets',
        item: 'Dataset',
        endpoint: 'KnowledgeEndpoint',
      },
      {
        file: 'rerank.yaml',
        zod: rerankCatalog,
        list: 'rerankers',
        item: 'Reranker',
        endpoint: 'RerankEndpoint',
      },
      {
        file: 'embeddings.yaml',
        zod: embeddingCatalog,
        list: 'models',
        item: 'Embedding',
        endpoint: 'EmbeddingEndpoint',
      },
    ];
    let catalogued = 0;
    for (const c of catalogs) {
      const { endpoints, items } = entries(catalogue(c.file), c.list);
      for (const e of endpoints)
        if (agrees(element(c.zod, 'endpoints'), schema(`${c.endpoint}@v1`), e, c.file))
          catalogued++;
      for (const i of items)
        if (agrees(element(c.zod, c.list), schema(`${c.item}@v1`), i, c.file)) catalogued++;
    }
    expect(catalogued).toBeGreaterThan(5);

    const settings = schema('Settings@v1');
    const defaults = Object.fromEntries(platformSettings.map((s) => [s.key, s.default]));
    expect(validator(settings)(defaults)).toBe(true);
    expect(validator(settings)({ ...defaults, 'no.such.setting': 1 })).toBe(false);
  });
});
