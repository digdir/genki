import type { ServiceDefinition } from '../../data/service-definition';
import { variantsOf } from '../../data/service-form';

export type VariantChoice = 'hidden' | 'choosable' | 'replaces';

type Spec = ServiceDefinition['spec'];
type VariantEntry = NonNullable<Spec['variants']>[number];

export interface NewVariant {
  id: string;
  title?: { nb: string; en: string } | undefined;
  choice: VariantChoice;
}

export const newVariantsOf = (inUse: Spec | undefined, draft: Spec): NewVariant[] => {
  const had = new Set(inUse ? variantsOf(inUse).map((v) => v.id) : []);
  return variantsOf(draft)
    .slice(1)
    .filter((v) => !had.has(v.id))
    .map((v) => ({ id: v.id, title: v.title, choice: v.chat === false ? 'hidden' : 'choosable' }));
};

const withChat = (v: VariantEntry, chat: boolean): VariantEntry => {
  const entry = typeof v === 'string' ? { id: v, aliases: [], overrides: {} } : v;
  const rest: Record<string, unknown> = { ...entry };
  delete rest.chat;
  return (chat ? rest : { ...rest, chat: false }) as unknown as VariantEntry;
};

const idOf = (v: VariantEntry) => (typeof v === 'string' ? v : v.id);

export const withVariantChoices = (
  definition: ServiceDefinition,
  choices: Record<string, VariantChoice>,
): ServiceDefinition => {
  const ids = Object.keys(choices);
  if (!ids.length) return definition;
  const variants = (definition.spec.variants ?? []).map((v) => {
    const choice = choices[idOf(v)];
    return choice ? withChat(v, choice !== 'hidden') : v;
  });
  const first = variants.find((v) => choices[idOf(v)] === 'replaces');
  const ordered = first ? [first, ...variants.filter((v) => v !== first)] : variants;
  return { ...definition, spec: { ...definition.spec, variants: ordered } };
};
