import type { GitDefinition } from './definition-sources.js';

export interface DroppedVariant {
  file: string;
  service: string;
  variant: string;
  model: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const modelOf = (variant: unknown) =>
  isRecord(variant) && typeof variant.model === 'string' ? variant.model : undefined;

const idOf = (variant: unknown) =>
  typeof variant === 'string' ? variant : isRecord(variant) ? String(variant.id) : '';

export const withoutUnknownVariantModels = (
  entries: GitDefinition[],
  knownModel: (id: string) => boolean,
): { definitions: GitDefinition[]; dropped: DroppedVariant[] } => {
  const dropped: DroppedVariant[] = [];
  const definitions = entries.map((entry) => {
    const spec = entry.definition.spec;
    if (!isRecord(spec) || !Array.isArray(spec.variants)) return entry;
    const unknown = spec.variants.filter((v) => {
      const model = modelOf(v);
      return model !== undefined && !knownModel(model);
    });
    if (unknown.length === 0 || unknown.length === spec.variants.length) return entry;
    for (const v of unknown)
      dropped.push({
        file: entry.file,
        service: entry.id,
        variant: idOf(v),
        model: modelOf(v) ?? '',
      });
    return {
      ...entry,
      definition: {
        ...entry.definition,
        spec: { ...spec, variants: spec.variants.filter((v) => !unknown.includes(v)) },
      },
    };
  });
  return { definitions, dropped };
};
