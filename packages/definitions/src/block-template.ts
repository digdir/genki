import { blockFieldRoots, fieldOf, type BlockField } from '@genai/contracts/block-fields';
import {
  isHttpsAddress,
  templateAliasPattern,
  templateDrawn,
  templateElements,
  templateIcons,
  templateLimits,
  templatePagePattern,
  templatePathPattern,
  type BlockTemplate,
  type TemplateAction,
  type TemplateCondition,
  type TemplateHref,
  type TemplateNode,
  type TemplateText,
  type TextPart,
} from '@genai/contracts/block-template';
import { blockStates } from '@genai/contracts/blocks';
import { z } from 'zod';
import type { ValidationError } from './validate.js';

export type { BlockTemplate, TemplateNode } from '@genai/contracts/block-template';

const L = templateLimits;
const elements = new Set<string>(templateElements);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const encoder = new TextEncoder();
const jsonBytesOf = (text: string) => encoder.encode(JSON.stringify(text)).length;

/** Refuses a template over the size, node or depth limits with an explicit stack, before any schema reads it. */
export const templatePrePass = (template: unknown): string | undefined => {
  let bytes = 0;
  let nodes = 0;
  const stack: { value: unknown; json: number; nodes: number }[] = [
    { value: template, json: 1, nodes: 0 },
  ];
  while (stack.length > 0) {
    const { value, json, nodes: above } = stack.pop() as (typeof stack)[number];
    if (json > L.jsonDepth) return `a template nests at most ${L.jsonDepth} levels of JSON`;
    if (typeof value === 'string') bytes += jsonBytesOf(value);
    else if (Array.isArray(value)) {
      bytes += 2 + Math.max(0, value.length - 1);
      for (const item of value) stack.push({ value: item, json: json + 1, nodes: above });
    } else if (isRecord(value)) {
      const isNode = typeof value.type === 'string' && elements.has(value.type);
      const depth = isNode ? above + 1 : above;
      if (isNode && ++nodes > L.nodes) return `a template has at most ${L.nodes} nodes`;
      if (depth > L.depth) return `a template nests at most ${L.depth} nodes deep`;
      const keys = Object.keys(value);
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        bytes += jsonBytesOf(key) + 1;
        stack.push({ value: value[key], json: json + 1, nodes: depth });
      }
    } else bytes += String(value).length;
    if (bytes > L.bytes) return `a template is at most ${L.bytes} bytes as JSON`;
  }
  return undefined;
};

const path = z
  .string()
  .max(160)
  .regex(templatePathPattern, 'must be a field path such as sources.title');
const alias = z.string().regex(templateAliasPattern, 'must be a short name in lower camel case');
const textKey = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9.-]{0,63}$/, 'must be letters, digits, dots and dashes');
const pageId = z.string().regex(templatePagePattern, 'must be the id of a page of the service');
const literal = z
  .string()
  .regex(
    /^[^\p{L}]{1,8}$/u,
    'a literal text has 1 to 8 characters and no letters; put words in texts',
  );

const textPart = z.union([
  literal,
  z.strictObject({
    t: textKey,
    args: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/, 'must be letters and digits'),
        z.union([path, z.strictObject({ count: path })]),
      )
      .refine((args) => Object.keys(args).length <= 8, 'at most 8 args')
      .optional(),
  }),
  z.strictObject({ bind: path, format: z.enum(['plain', 'date', 'number']).optional() }),
  z.strictObject({ count: path }),
]);

const text = z.union([textPart, z.array(textPart).min(1).max(L.textParts)]);

const href = z.union([
  z.string().max(2_000).refine(isHttpsAddress, 'must be an https address'),
  z.strictObject({ bind: path }),
  z.strictObject({ page: pageId }),
]);

const action = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('ask'), question: text }),
  z.strictObject({ name: z.literal('open-document'), source: path }),
  z.strictObject({
    name: z.literal('set-filter'),
    field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, 'must be the id of a filter field'),
    values: z.union([path, z.array(z.string().max(L.filterValue)).max(L.filterValues)]),
  }),
  z.strictObject({ name: z.literal('open-page'), page: pageId }),
  z.strictObject({ name: z.literal('notify'), text }),
]);

const condition: z.ZodType<TemplateCondition> = z.lazy(
  () =>
    z.union([
      z.strictObject({ exists: path }),
      z.strictObject({ empty: path }),
      z.strictObject({
        equals: z.tuple([path, z.union([z.string().max(200), z.number(), z.boolean()])]),
      }),
      z.strictObject({ state: z.enum(blockStates) }),
      z.strictObject({ not: condition }),
    ]) as unknown as z.ZodType<TemplateCondition>,
);

const gap = z.enum(['none', 'sm', 'md', 'lg']).optional();
const max = z.number().int().min(1).max(L.eachMax).optional();

const node: z.ZodType<TemplateNode> = z.lazy(
  () =>
    z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('stack'), gap, children: z.array(node) }),
      z.strictObject({
        type: z.literal('row'),
        gap,
        wrap: z.boolean().optional(),
        align: z.enum(['start', 'center', 'end', 'baseline']).optional(),
        children: z.array(node),
      }),
      z.strictObject({
        type: z.literal('card'),
        variant: z.enum(['default', 'tinted']).optional(),
        children: z.array(node),
      }),
      z.strictObject({
        type: z.literal('details'),
        summary: text,
        open: z.boolean().optional(),
        children: z.array(node),
      }),
      z.strictObject({
        type: z.literal('heading'),
        level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
        size: z.enum(['2xs', 'xs', 'sm', 'md']).optional(),
        text,
      }),
      z.strictObject({
        type: z.literal('paragraph'),
        size: z.enum(['sm', 'md']).optional(),
        variant: z.enum(['default', 'subtle']).optional(),
        text,
      }),
      z.strictObject({
        type: z.literal('list'),
        ordered: z.boolean().optional(),
        items: z.array(node),
      }),
      z.strictObject({ type: z.literal('link'), href, text }),
      z.strictObject({
        type: z.literal('button'),
        variant: z.enum(['primary', 'secondary', 'tertiary']).optional(),
        text,
        event: action,
      }),
      z.strictObject({
        type: z.literal('tag'),
        color: z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'accent']).optional(),
        text,
      }),
      z.strictObject({
        type: z.literal('alert'),
        color: z.enum(['info', 'success', 'warning', 'danger']),
        text,
      }),
      z.strictObject({ type: z.literal('divider') }),
      z.strictObject({
        type: z.literal('icon'),
        name: z.enum(templateIcons),
        label: text.optional(),
      }),
      z.strictObject({
        type: z.literal('table'),
        rows: path,
        as: alias,
        max,
        columns: z
          .array(z.strictObject({ header: text, cell: node }))
          .min(1)
          .max(L.columns),
      }),
      z.strictObject({
        type: z.literal('keyValue'),
        items: z
          .array(z.strictObject({ key: text, value: text }))
          .min(1)
          .max(L.keyValueItems),
      }),
      z.strictObject({
        type: z.literal('each'),
        of: path,
        as: alias,
        max,
        children: z.array(node),
      }),
      z.strictObject({
        type: z.literal('if'),
        when: condition,
        then: z.array(node),
        else: z.array(node).optional(),
      }),
    ]) as unknown as z.ZodType<TemplateNode>,
);

const templateShape = z.strictObject({
  version: z.literal(1),
  root: node,
  states: z.partialRecord(z.enum(blockStates), node).optional(),
});

/** The declarative tier's template: bounded by a pre-pass, then parsed. */
export const blockTemplate = z
  .unknown()
  .superRefine((value, ctx) => {
    const refused = templatePrePass(value);
    if (refused) ctx.addIssue({ code: 'custom', message: refused });
  })
  .pipe(templateShape) as unknown as z.ZodType<BlockTemplate>;

interface Scope {
  alias: string;
  list: string;
  parent: Scope | undefined;
}

type Resolved =
  | { kind: 'list'; canonical: string; field: BlockField }
  | { kind: 'item'; canonical: string; field: BlockField }
  | { kind: 'value'; canonical: string; type: string; prop?: boolean };

interface TemplateSpec {
  zones?: readonly string[] | undefined;
  events?: readonly string[] | undefined;
  states?: readonly string[] | undefined;
  texts?: Partial<Record<string, Record<string, string>>> | undefined;
  props?: { properties: Record<string, Record<string, unknown>> } | undefined;
}

const roots = new Set<string>([...blockFieldRoots, 'props']);

const lookup = (scope: Scope | undefined, name: string) => {
  for (let at = scope; at; at = at.parent) if (at.alias === name) return at;
  return undefined;
};

const analyse = (template: BlockTemplate, spec: TemplateSpec | undefined) => {
  const errors: ValidationError[] = [];
  const reads = new Set<string>();
  let paths = 0;
  const fail = (at: string, message: string) => errors.push({ path: at, message });

  const resolve = (p: string, scope: Scope | undefined, at: string): Resolved | undefined => {
    if (++paths === L.paths + 1) fail(at, `a template reads at most ${L.paths} paths`);
    const segments = p.split('.');
    const head = segments[0] ?? '';
    const item = lookup(scope, head);
    if (!item && head === 'props') {
      const key = segments[1];
      const prop =
        segments.length === 2 && key && spec?.props && Object.hasOwn(spec.props.properties, key)
          ? spec.props.properties[key]
          : undefined;
      if (!prop) return void fail(at, `${p} is not a prop of the block`);
      return { kind: 'value', canonical: p, type: String(prop.type ?? 'string'), prop: true };
    }
    if (!item && !roots.has(head)) return void fail(at, `${p} is not a field a block may read`);
    const canonical = item ? [item.list, ...segments.slice(1)].join('.') : p;
    const field = fieldOf(canonical);
    if (!field) return void fail(at, `${p} is not a field a block may read`);
    const parts = canonical.split('.');
    const covered = item ? item.list.split('.').length : 0;
    for (let i = 1; i <= parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('.');
      const outer = fieldOf(prefix);
      if (outer?.zones && spec?.zones?.some((zone) => !outer.zones?.includes(zone as never)))
        return void fail(at, `${p} is not given in every zone the block may stand in`);
      if (i < parts.length && i > covered && outer?.type === 'list')
        return void fail(at, `${p} reads an item of ${prefix} outside an each over it`);
    }
    reads.add(canonical);
    if (item && segments.length === 1)
      return field.of === 'string'
        ? { kind: 'value', canonical, type: 'string' }
        : { kind: 'item', canonical, field };
    return field.type === 'list'
      ? { kind: 'list', canonical, field }
      : { kind: 'value', canonical, type: field.type };
  };

  const value = (p: string, scope: Scope | undefined, at: string) => {
    const found = resolve(p, scope, at);
    if (found && found.kind !== 'value')
      fail(at, `${p} is a list, so it cannot stand where one value is needed`);
    return found?.kind === 'value' ? found : undefined;
  };

  const list = (p: string, scope: Scope | undefined, at: string) => {
    const found = resolve(p, scope, at);
    if (found && found.kind !== 'list') fail(at, `${p} is not a list`);
    return found?.kind === 'list' ? found : undefined;
  };

  const textKeyIn = (key: string, at: string) => {
    const nb = spec?.texts?.nb ?? {};
    if (spec && !Object.hasOwn(nb, key)) fail(at, `${key} is not a text in bokmål`);
  };

  const part = (one: TextPart, scope: Scope | undefined, at: string) => {
    if (typeof one === 'string') return;
    if ('t' in one) {
      const args = one.args ?? {};
      if (Object.hasOwn(args, 'count') && typeof args.count === 'object') {
        textKeyIn(`${one.t}.one`, `${at}.t`);
        textKeyIn(`${one.t}.other`, `${at}.t`);
      } else textKeyIn(one.t, `${at}.t`);
      for (const [name, arg] of Object.entries(args)) {
        if (typeof arg === 'string') value(arg, scope, `${at}.args.${name}`);
        else list(arg.count, scope, `${at}.args.${name}.count`);
      }
    } else if ('bind' in one) {
      const found = value(one.bind, scope, `${at}.bind`);
      if (found && one.format === 'date' && found.type !== 'date')
        fail(`${at}.format`, `${one.bind} is not a date`);
      if (found && one.format === 'number' && found.type !== 'number')
        fail(`${at}.format`, `${one.bind} is not a number`);
    } else list(one.count, scope, `${at}.count`);
  };

  const textOf = (t: TemplateText, scope: Scope | undefined, at: string) => {
    if (Array.isArray(t)) t.forEach((one, i) => part(one, scope, `${at}[${i}]`));
    else part(t, scope, at);
  };

  const hrefOf = (h: TemplateHref, scope: Scope | undefined, at: string) => {
    if (typeof h === 'object' && 'bind' in h) {
      const found = value(h.bind, scope, `${at}.bind`);
      if (found && found.type !== 'url') fail(`${at}.bind`, `${h.bind} is not an address`);
    }
  };

  const event = (a: TemplateAction, scope: Scope | undefined, at: string) => {
    if (spec && !(spec.events ?? []).includes(a.name))
      fail(`${at}.name`, `${a.name} is not one of the events the block declares`);
    if (a.name === 'ask') textOf(a.question, scope, `${at}.question`);
    if (a.name === 'notify') textOf(a.text, scope, `${at}.text`);
    if (a.name === 'open-document') {
      const found = value(a.source, scope, `${at}.source`);
      if (found && found.canonical !== 'sources.index')
        fail(`${at}.source`, 'open-document names the index of a source');
    }
    if (a.name === 'set-filter' && typeof a.values === 'string') {
      const found = resolve(a.values, scope, `${at}.values`);
      if (found && !(found.kind === 'list' && found.field.of === 'string'))
        fail(`${at}.values`, `${a.values} is not a list of texts`);
    }
  };

  const stateIn = (state: string, at: string) => {
    if (spec && !(spec.states ?? []).includes(state))
      fail(at, `${state} is not one of the states the block declares`);
  };

  const conditionOf = (c: TemplateCondition, scope: Scope | undefined, at: string) => {
    let current = c;
    let where = at;
    for (let depth = 1; ; depth += 1) {
      if (depth > L.conditionDepth)
        return fail(where, `a condition nests at most ${L.conditionDepth} deep`);
      if ('not' in current) {
        current = current.not;
        where = `${where}.not`;
        continue;
      }
      if ('exists' in current) resolve(current.exists, scope, `${where}.exists`);
      else if ('empty' in current) resolve(current.empty, scope, `${where}.empty`);
      else if ('equals' in current) value(current.equals[0], scope, `${where}.equals[0]`);
      else stateIn(current.state, `${where}.state`);
      return;
    }
  };

  const bind = (name: string, listPath: string, scope: Scope | undefined, at: string) => {
    if (roots.has(name)) {
      fail(at, `${name} is the name of a field, so it cannot name an item`);
      return scope;
    }
    if (lookup(scope, name)) fail(at, `${name} already names an item here`);
    return { alias: name, list: listPath, parent: scope };
  };

  if (templateDrawn(template) > L.drawn)
    fail('spec.template', `a template draws at most ${L.drawn} elements once its lists repeat`);
  const stack: { node: TemplateNode; at: string; scope: Scope | undefined; nested: number }[] = [];
  const push = (nodes: TemplateNode[], at: string, scope: Scope | undefined, nested: number) =>
    nodes.forEach((child, i) => stack.push({ node: child, at: `${at}[${i}]`, scope, nested }));

  stack.push({ node: template.root, at: 'spec.template.root', scope: undefined, nested: 0 });
  for (const [state, branch] of Object.entries(template.states ?? {})) {
    stateIn(state, `spec.template.states.${state}`);
    if (branch)
      stack.push({
        node: branch,
        at: `spec.template.states.${state}`,
        scope: undefined,
        nested: 0,
      });
  }

  while (stack.length > 0) {
    const { node: n, at, scope, nested } = stack.pop() as (typeof stack)[number];
    switch (n.type) {
      case 'stack':
      case 'row':
      case 'card':
        push(n.children, `${at}.children`, scope, nested);
        break;
      case 'details':
        textOf(n.summary, scope, `${at}.summary`);
        push(n.children, `${at}.children`, scope, nested);
        break;
      case 'heading':
      case 'paragraph':
      case 'tag':
      case 'alert':
        textOf(n.text, scope, `${at}.text`);
        break;
      case 'list':
        push(n.items, `${at}.items`, scope, nested);
        break;
      case 'link':
        hrefOf(n.href, scope, `${at}.href`);
        textOf(n.text, scope, `${at}.text`);
        break;
      case 'button':
        textOf(n.text, scope, `${at}.text`);
        event(n.event, scope, `${at}.event`);
        break;
      case 'icon':
        if (n.label) textOf(n.label, scope, `${at}.label`);
        break;
      case 'keyValue':
        n.items.forEach((item, i) => {
          textOf(item.key, scope, `${at}.items[${i}].key`);
          textOf(item.value, scope, `${at}.items[${i}].value`);
        });
        break;
      case 'each':
      case 'table': {
        const over = n.type === 'each' ? n.of : n.rows;
        const where = `${at}.${n.type === 'each' ? 'of' : 'rows'}`;
        if (nested + 1 > L.listNesting) {
          fail(at, `each and table nest at most ${L.listNesting} deep`);
          break;
        }
        const found = list(over, scope, where);
        if (!found) break;
        const inner = bind(n.as, found.canonical, scope, `${at}.as`);
        if (n.type === 'each') push(n.children, `${at}.children`, inner, nested + 1);
        else
          n.columns.forEach((column, i) => {
            textOf(column.header, scope, `${at}.columns[${i}].header`);
            stack.push({
              node: column.cell,
              at: `${at}.columns[${i}].cell`,
              scope: inner,
              nested: nested + 1,
            });
          });
        break;
      }
      case 'if':
        conditionOf(n.when, scope, `${at}.when`);
        push(n.then, `${at}.then`, scope, nested);
        if (n.else) push(n.else, `${at}.else`, scope, nested);
        break;
      case 'divider':
        break;
    }
  }
  return { errors, reads };
};

/** Every rule of the declarative tier: bindings in the field list, declared events, states and texts, the limits. */
export const checkBlockTemplate = (
  spec: TemplateSpec & { template?: BlockTemplate | undefined },
): ValidationError[] =>
  spec.template
    ? analyse(spec.template, spec).errors
    : [{ path: 'spec.template', message: 'a declarative block has a template' }];

/** The canonical field paths a template reads, a list left out when a field under it is read. */
export const templateReads = (template: BlockTemplate | undefined): string[] => {
  if (!template) return [];
  const all = [...analyse(template, undefined).reads];
  return all.filter((p) => !all.some((other) => other.startsWith(`${p}.`))).sort();
};
