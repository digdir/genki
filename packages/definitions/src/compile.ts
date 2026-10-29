import { inputFieldsSchema, type CapabilityDescriptor } from '@genai/contracts';
import type { Capability } from '@genai/kernel';
import { resolvePrompts, type PromptFiles } from './prompts.js';
import {
  publicNamesOf,
  toolRef,
  variantChatOf,
  variantId,
  variantModelOf,
  variantStrategyOf,
  variantTitleOf,
  type ServiceDefinition,
} from './schema.js';

export interface CompiledCapability {
  capability: Capability;
  service: { tenant: string; id: string; version: number };
  serviceName?: string;
  variant: string;
  chat?: false;
  publicName: string;
  aliases: string[];
  variantTitle?: { nb: string; en: string };
}

export const capabilityId = (tenant: string, service: string, variant: string) =>
  `${tenant}/${service}/${variant}`;

const produces: Record<ServiceDefinition['spec']['output']['kind'], string[]> = {
  answer: ['text/plain', 'text/markdown'],
  fields: ['application/json'],
  table: ['application/vnd.genai.table+json', 'text/csv'],
  document: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
};

const interaction = (spec: ServiceDefinition['spec']): CapabilityDescriptor['interaction'] => [
  'unary',
  ...(spec.exposure.chat || spec.exposure.mcp || spec.exposure.openai || spec.exposure.a2a
    ? (['stream'] as const)
    : []),
  ...(spec.batch?.enabled || spec.triggers.length > 0 ? (['async'] as const) : []),
];

const variantFilters = (variant: ServiceDefinition['spec']['variants'][number]) =>
  typeof variant === 'string' ? undefined : variant.filters;

export const toCapabilities = (
  definition: ServiceDefinition,
  version: number,
  files: PromptFiles = {},
): CompiledCapability[] => {
  const { metadata, spec } = definition;
  const name = metadata.name ?? metadata.id;
  const ref = (kind: string, id: string) => ({ kind, id, tenant: metadata.tenant });
  return spec.variants.map((variant) => {
    const id = variantId(variant);
    const model = { ...spec.model, primary: variantModelOf(variant) ?? spec.model.primary };
    const strategy = variantStrategyOf(spec, variant);
    const overrides = typeof variant === 'string' ? {} : variant.overrides;
    const config =
      Object.keys(overrides).length === 0
        ? strategy.config
        : { ...(strategy.config as Record<string, unknown>), ...overrides };
    const descriptor: CapabilityDescriptor = {
      id: capabilityId(metadata.tenant, metadata.id, id),
      version: String(version),
      tenant: metadata.tenant,
      ...(spec.availableTo === undefined ? {} : { availableTo: spec.availableTo }),
      title: id === 'default' ? name : `${name} (${id})`,
      description: spec.purpose,
      input: spec.input.fields?.length ? inputFieldsSchema(spec.input.fields) : {},
      ...(spec.input.fields?.length ? { inputFields: spec.input.fields } : {}),
      interaction: interaction(spec),
      accepts: spec.input.accepts,
      produces: produces[spec.output.kind],
      emits: [],
      oversight: {
        interrupts: spec.riskClass === 'high' || 'human-approval' in spec.guardrails,
        riskClass: spec.riskClass,
        aiDisclosure: 'Svaret er laget med kunstig intelligens.',
      },
    };
    const capability: Capability = {
      descriptor,
      strategy: { id: strategy.id, version: String(strategy.version) },
      config: {
        strategy: resolvePrompts(config, files),
        settings: spec.settings,
        languages: spec.languages,
        ...(spec.callOverrides ? { callOverrides: spec.callOverrides } : {}),
        output: spec.output,
        model: { ...model, tenant: metadata.tenant },
        knowledge: variantFilters(variant)
          ? { ...spec.knowledge, filters: variantFilters(variant) }
          : spec.knowledge,
        tools: spec.tools.map(toolRef),
        guardrails: spec.guardrails,
      },
      grants: [
        ...spec.knowledge.datasets.map((k) => ({
          port: 'knowledge',
          ref: ref('dataset', k.dataset),
        })),
        ...spec.tools.map((t) => ({ port: 'tools', ref: ref('tool', toolRef(t)) })),
        ...(spec.knowledge.reranker
          ? [{ port: 'rerank', ref: ref('reranker', spec.knowledge.reranker) }]
          : []),
        ...(model.primary ? [{ port: 'model', ref: ref('model', model.primary) }] : []),
        ...(spec.model.fallback ? [{ port: 'model', ref: ref('model', spec.model.fallback) }] : []),
        ...[...new Set(Object.values(spec.model.roles ?? {}))]
          .filter(
            (id): id is string =>
              id !== undefined && id !== model.primary && id !== spec.model.fallback,
          )
          .map((id) => ({ port: 'model', ref: ref('model', id) })),
      ],
    };
    const names = publicNamesOf(definition, variant);
    return {
      capability,
      service: { tenant: metadata.tenant, id: metadata.id, version },
      serviceName: name,
      variant: id,
      ...(variantChatOf(variant) ? {} : { chat: false as const }),
      publicName: names.primary,
      aliases: names.aliases,
      ...(variantTitleOf(variant)
        ? { variantTitle: variantTitleOf(variant) as { nb: string; en: string } }
        : {}),
    };
  });
};
