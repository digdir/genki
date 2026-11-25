import { enBuilder, nbBuilder } from '@genai/ui-blocks/builder';
import type { Locale } from '@genai/i18n';

export type PropValue = boolean | string;
export type PropSchema = Record<string, unknown>;

export const propsOf = (definition: Record<string, unknown>): Record<string, PropSchema> => {
  const spec = (definition as { spec?: { props?: { properties?: Record<string, PropSchema> } } })
    .spec;
  return spec?.props?.properties ?? {};
};

export const choicesOf = (schema: PropSchema): string[] | undefined =>
  Array.isArray(schema.enum)
    ? schema.enum.filter((v): v is string => typeof v === 'string')
    : undefined;

/** Each prop's value as the edition draws it when nothing is set: its default, or off or the first choice. */
export const defaultsOf = (props: Record<string, PropSchema>): Record<string, PropValue> =>
  Object.fromEntries(
    Object.entries(props).flatMap(([key, schema]) => {
      const given = schema.default;
      if (typeof given === 'boolean' || typeof given === 'string') return [[key, given]];
      if (schema.type === 'boolean') return [[key, false]];
      const choices = choicesOf(schema);
      if (choices?.[0] !== undefined) return [[key, choices[0]]];
      if (schema.type === 'string') return [[key, '']];
      return [];
    }),
  );

const builderWords = (locale: Locale) =>
  (locale === 'en' ? enBuilder : nbBuilder) as Record<string, string>;

/** The prop's label: genki's own word for a `builder.` key, else its title, else its name. */
export const labelOf = (key: string, schema: PropSchema, locale: Locale, choice?: string) => {
  const label = typeof schema['x-label'] === 'string' ? schema['x-label'] : undefined;
  const word = label?.startsWith('builder.') ? label.slice('builder.'.length) : undefined;
  const words = builderWords(locale);
  if (choice !== undefined) {
    const found = word
      ? words[`${word}${choice.charAt(0).toUpperCase()}${choice.slice(1)}`]
      : undefined;
    return found ?? choice;
  }
  if (word && words[word]) return words[word];
  if (label && !word) return label;
  return typeof schema.title === 'string' ? schema.title : key;
};

/** The edition's props with the chosen values as their defaults, so the next edition draws them. */
export const withDefaults = (
  properties: Record<string, PropSchema>,
  values: Record<string, PropValue>,
): Record<string, PropSchema> =>
  Object.fromEntries(
    Object.entries(properties).map(([key, schema]) => [
      key,
      key in values ? { ...schema, default: values[key] } : schema,
    ]),
  );

const fieldPattern = /^(\S+) is not a field a block may read$/;

/** The data fields a check refused because genki does not send them. */
export const missingFields = (errors: readonly { message: string }[]) => [
  ...new Set(errors.flatMap((e) => fieldPattern.exec(e.message)?.slice(1, 2) ?? [])),
];

export const coreIssueLink = (title: string, body: string) =>
  `https://github.com/digdir/genki/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
