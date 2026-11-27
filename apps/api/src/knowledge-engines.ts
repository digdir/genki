import {
  knowledgeCapabilities,
  knowledgeEndpointSchemaFor,
  legacyCapabilities,
  type DatasetDraft,
  type IndexWriterAdapter,
  type KnowledgeAdapter,
  type KnowledgeCapability,
  type Residency,
} from '@genai/port-knowledge';
import { z } from 'zod';
import { translate, type ApiKey } from './i18n/index.js';
import { platformDataLocation } from './residency.js';

export interface EngineDescription {
  engine: string;
  title: string;
  tech?: string;
  builtin: boolean;
  runsAt?: string;
  dataLocation?: Residency;
  writeKeyRequired: boolean;
  probe: boolean;
  requiresBaseURL: boolean;
  endpoint?: Record<string, unknown>;
  endpointOptions?: Record<string, unknown>;
  datasetOptions?: Record<string, unknown>;
  capabilities: KnowledgeCapability[];
  writer?: { needsVectors: boolean };
}

const schemaOf = (schema: unknown) => {
  try {
    return z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
};

const titles: Record<string, ApiKey> = {
  'http-search': 'services.engineHttp',
  mcp: 'services.engineMcp',
};

const engineTitle = (engine: string) => {
  const key = titles[engine];
  return key ? translate(key) : engine;
};

const probeEmbedding = { model: 'probe', dimensions: 8 };

const offered = (adapter: KnowledgeAdapter): KnowledgeCapability[] => {
  if (!adapter.capabilities) return [...legacyCapabilities];
  const draft: DatasetDraft = {
    filters: {},
    options: {},
    embedding: probeEmbedding,
  };
  const options = { ...draft.options, ...(adapter.defaults?.(draft) ?? {}) };
  const parsed = adapter.datasetOptions.safeParse(options);
  if (!parsed.success) return [];
  try {
    const found = new Set(
      adapter.capabilities({
        id: 'probe',
        filters: {},
        options: parsed.data,
        embedding: probeEmbedding,
      }),
    );
    return knowledgeCapabilities.filter((c) => found.has(c));
  } catch {
    return [];
  }
};

export interface DescribeOptions {
  platformDataLocation?: Residency;
}

export const describeEngines = (
  adapters: KnowledgeAdapter[],
  writers: IndexWriterAdapter[],
  options: DescribeOptions = { platformDataLocation },
): EngineDescription[] =>
  adapters
    .map((adapter): EngineDescription => {
      const writer = writers.find((w) => w.engine === adapter.engine);
      const builtin = adapter.requiresBaseURL === false;
      const endpoint = schemaOf(knowledgeEndpointSchemaFor(adapter));
      const endpointOptions = schemaOf(adapter.endpointOptions);
      const datasetOptions = schemaOf(adapter.datasetOptions);
      const dataLocation =
        adapter.dataLocation ?? (builtin ? options.platformDataLocation : undefined);
      return {
        engine: adapter.engine,
        title: adapter.title ?? engineTitle(adapter.engine),
        ...(adapter.tech ? { tech: adapter.tech } : {}),
        builtin,
        ...(builtin ? { runsAt: 'platform' } : {}),
        ...(dataLocation ? { dataLocation } : {}),
        writeKeyRequired: false,
        probe: adapter.probe !== undefined,
        requiresBaseURL: !builtin,
        ...(endpoint ? { endpoint } : {}),
        ...(endpointOptions ? { endpointOptions } : {}),
        ...(datasetOptions ? { datasetOptions } : {}),
        capabilities: offered(adapter),
        ...(writer ? { writer: { needsVectors: writer.needs.vectors } } : {}),
      };
    })
    .sort((a, b) => a.engine.localeCompare(b.engine));
