export const schemaWidgets = [
  'text',
  'textarea',
  'prompt',
  'number',
  'toggle',
  'select',
  'multiselect',
  'model',
  'dataset',
  'tool',
  'secret',
  'cron',
  'code',
  'list',
  'map',
] as const;
export type SchemaWidget = (typeof schemaWidgets)[number];

export const isSchemaWidget = (value: unknown): value is SchemaWidget =>
  (schemaWidgets as readonly unknown[]).includes(value);

export const schemaLocales = ['nb', 'en'] as const;
export type SchemaLocale = (typeof schemaLocales)[number];

export type UiText = Record<SchemaLocale, string>;

export type SchemaOptions =
  | { enum: (string | number | boolean)[] }
  | { route: string; items?: string; value?: string; label?: string };

export interface ShowIf {
  field: string;
  equals?: unknown;
  in?: unknown[];
}

export interface PropertyMeta {
  'x-group'?: UiText;
  'x-order'?: number;
  'x-widget'?: SchemaWidget;
  'x-options'?: SchemaOptions;
  'x-right'?: string;
  'x-operator'?: boolean;
  'x-settableAt'?: string[];
  'x-readOnly'?: boolean;
  'x-advanced'?: boolean;
  'x-showIf'?: ShowIf;
  'x-sensitive'?: boolean;
}

export interface LabelText {
  label: string;
  help?: string;
  values?: Record<string, string>;
}

export interface SchemaLabels {
  nb: Record<string, LabelText>;
  en: Record<string, LabelText>;
  meta?: Record<string, PropertyMeta>;
  titles?: Record<string, UiText>;
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const childLists = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const;

const localizedKeys = new Set(['x-label', 'x-help', 'x-group']);

export interface SchemaProperty {
  path: string;
  name: string;
  node: Node;
}

const visit = (node: Node, path: string[], each: (property: SchemaProperty) => void) => {
  if (isNode(node.properties))
    for (const [name, child] of Object.entries(node.properties)) {
      if (!isNode(child)) continue;
      each({ path: [...path, name].join('.'), name, node: child });
      visit(child, [...path, name], each);
    }
  for (const key of ['items', 'additionalProperties', 'not'])
    if (isNode(node[key])) visit(node[key], path, each);
  for (const key of childLists) {
    const list = node[key];
    if (Array.isArray(list)) for (const child of list) if (isNode(child)) visit(child, path, each);
  }
  for (const key of ['$defs', 'definitions'])
    if (isNode(node[key]))
      for (const child of Object.values(node[key])) if (isNode(child)) visit(child, [], each);
};

export const schemaProperties = (schema: Node): SchemaProperty[] => {
  const found: SchemaProperty[] = [];
  visit(schema, [], (property) => found.push(property));
  return found;
};

const deref = (root: Node, node: Node): Node => {
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let at: unknown = root;
  for (const part of ref.slice(2).split('/')) at = isNode(at) ? at[part] : undefined;
  return isNode(at) ? at : node;
};

const branches = (node: Node): Node[] =>
  [
    ...(Array.isArray(node.anyOf) ? node.anyOf : []),
    ...(Array.isArray(node.oneOf) ? node.oneOf : []),
  ]
    .filter(isNode)
    .filter((b) => b.type !== 'null');

const isChoice = (node: Node) => Array.isArray(node.enum) || 'const' in node;

const inferWidget = (root: Node, raw: Node): SchemaWidget | undefined => {
  const node = deref(root, raw);
  if (node['x-secret'] === true) return 'secret';
  if (isChoice(node)) return 'select';
  const options = branches(node);
  if (options.length > 0) {
    if (options.every(isChoice)) return 'select';
    if (options.some((b) => isNode(deref(root, b).properties))) return undefined;
    return inferWidget(root, options[0] as Node);
  }
  const type = Array.isArray(node.type)
    ? node.type.find((t) => t !== 'null')
    : (node.type as string | undefined);
  if (type === 'boolean') return 'toggle';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'string') return 'text';
  if (type === 'array') {
    const items = isNode(node.items) ? deref(root, node.items) : {};
    const choices = branches(items);
    return isChoice(items) || (choices.length > 0 && choices.every(isChoice))
      ? 'multiselect'
      : 'list';
  }
  if (type === 'object') {
    if (isNode(node.properties)) return undefined;
    return isNode(node.additionalProperties) ? 'map' : 'code';
  }
  return 'code';
};

const findLabel = (catalogues: SchemaLabels[], keys: string[]) => {
  for (const key of keys)
    for (const catalogue of catalogues) {
      const nb = catalogue.nb[key];
      if (nb) return { nb, en: catalogue.en[key] };
    }
  return undefined;
};

const metaFor = (catalogues: SchemaLabels[], keys: string[]): PropertyMeta => {
  const merged: PropertyMeta = {};
  for (const key of [...keys].reverse())
    for (const catalogue of [...catalogues].reverse())
      Object.assign(merged, catalogue.meta?.[key] ?? {});
  return merged;
};

const both = (nb: string | undefined, en: string | undefined) =>
  nb === undefined && en === undefined ? undefined : ({ nb, en } as UiText);

const clone = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

export const annotateSchema = (schema: Node, catalogues: SchemaLabels[]): Node => {
  const root = clone(schema) as Node;
  visit(root, [], ({ path, node }) => {
    const parts = path.split('.');
    const keys = [`$.${path}`, ...parts.map((_, i) => parts.slice(i).join('.'))];
    const text = findLabel(catalogues, keys);
    if (text) {
      node['x-label'] = both(text.nb.label, text.en?.label);
      const help = both(text.nb.help, text.en?.help);
      if (help) node['x-help'] = help;
      if (text.nb.values)
        node['x-enumLabels'] = Object.fromEntries(
          Object.entries(text.nb.values).map(([value, nb]) => [
            value,
            both(nb, text.en?.values?.[value]),
          ]),
        );
    }
    Object.assign(node, metaFor(catalogues, keys));
    if (node['x-secret'] === true) node['x-sensitive'] = true;
    if (node['x-widget'] === undefined) {
      const widget = inferWidget(root, node);
      if (widget) node['x-widget'] = widget;
    }
  });
  return root;
};

const pick = (value: unknown, locale: SchemaLocale) =>
  isNode(value) && typeof value[locale] === 'string' ? value[locale] : value;

export const localizeSchema = (schema: unknown, locale: SchemaLocale): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => localizeSchema(item, locale));
  if (!isNode(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (localizedKeys.has(key)) return [key, pick(value, locale)];
      if (key === 'x-enumLabels' && isNode(value))
        return [
          key,
          Object.fromEntries(Object.entries(value).map(([v, text]) => [v, pick(text, locale)])),
        ];
      return [key, localizeSchema(value, locale)];
    }),
  );
};

export const missingLabels = (schema: Node): string[] =>
  schemaProperties(schema)
    .filter(({ node }) => {
      const label = node['x-label'];
      return !(
        isNode(label) &&
        schemaLocales.every((l) => typeof label[l] === 'string' && (label[l] as string).trim())
      );
    })
    .map(({ path }) => path);
