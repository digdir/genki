import { fieldOf } from '@genai/contracts/block-fields';
import {
  isHttpsAddress,
  templateLimits,
  templatePagePattern,
  templatePathPattern,
  type TemplateNode,
  type TemplateText,
  type TextPart,
} from '@genai/contracts/block-template';
import { blockZones, type BlockEvent, type BlockZone } from '@genai/contracts/blocks';
import type { Findings } from './report.js';
import {
  attr,
  childrenOf,
  elementsOf,
  isElement,
  isText,
  type ChildNode,
  type Element,
  type ParentNode,
} from './tree.js';

export const textLimits = { keys: 200, characters: 1_000 } as const;

const fold = (text: string) =>
  text
    .toLowerCase()
    .replaceAll('æ', 'ae')
    .replaceAll('ø', 'o')
    .replaceAll('å', 'a')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');

/** Bokmål text keys named from a text's first words, the same key for the same text. */
export const textKeys = () => {
  const byText = new Map<string, string>();
  const used = new Set<string>();
  const nb: Record<string, string> = {};
  let overflow = false;
  return {
    nb,
    get overflow() {
      return overflow;
    },
    keyFor(text: string) {
      const known = byText.get(text);
      if (known) return known;
      if (text.length > textLimits.characters || used.size >= textLimits.keys) overflow = true;
      const words = fold(text)
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .slice(0, 3);
      const base = text.length <= 60 && /^[a-z]/.test(words[0] ?? '') ? words.join('-') : '';
      let key = base || `t${used.size + 1}`;
      for (let n = 2; used.has(key); n += 1) key = `${base || 't'}-${n}`;
      used.add(key);
      byText.set(text, key);
      nb[key] = text.slice(0, textLimits.characters);
      return key;
    },
  };
};

export type TextKeys = ReturnType<typeof textKeys>;

export interface Context {
  notes: Findings;
  texts: TextKeys;
  events: Set<BlockEvent>;
  reads: Set<string>;
  each?: { of: string; as: string } | undefined;
}

const inlineTags = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);

const silent = new Set(['meta', 'title', 'noscript', 'template', 'br', 'wbr']);

type Segment = { text: string } | { bind: string };

const designClasses = /(?:^|\s)ds-(?:card|tag|alert)(?:\s|$)/;

const isInline = (node: ChildNode) =>
  isText(node) ||
  (isElement(node) &&
    inlineTags.has(node.tagName) &&
    !designClasses.test(attr(node, 'class') ?? ''));

const bindPattern = /\{\{\s*([a-zA-Z0-9.]{1,160})\s*\}\}/g;

/** A path from the design as a template path, or nothing when the block may not read it there. */
const bindOf = (raw: string, ctx: Context): TextPart | undefined => {
  const path = raw.trim();
  if (!templatePathPattern.test(path)) return undefined;
  let canonical = path;
  let inTemplate = path;
  const each = ctx.each;
  if (each && path.startsWith(`${each.as}.`)) canonical = `${each.of}${path.slice(each.as.length)}`;
  else if (each && path.startsWith(`${each.of}.`))
    inTemplate = `${each.as}${path.slice(each.of.length)}`;
  const field = fieldOf(canonical);
  if (!field || field.type === 'list') return undefined;
  const parent = canonical.slice(0, Math.max(0, canonical.lastIndexOf('.')));
  const inList = parent !== '' && fieldOf(parent)?.type === 'list';
  if (inList && parent !== each?.of) return undefined;
  ctx.reads.add(canonical);
  const format = field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : undefined;
  return { bind: inTemplate, ...(format ? { format } : {}) };
};

const segmentsOf = (root: Element, ctx: Context, where: string): Segment[] => {
  const own = attr(root, 'data-genki-bind');
  if (own !== undefined) return [{ bind: own }];
  const segments: Segment[] = [];
  const stack: ChildNode[] = [];
  const pushChildren = (node: ParentNode) => {
    const inner = childrenOf(node);
    for (let i = inner.length - 1; i >= 0; i -= 1) stack.push(inner[i] as ChildNode);
  };
  pushChildren(root);
  while (stack.length > 0) {
    const node = stack.pop() as ChildNode;
    if (isText(node)) {
      segments.push({ text: node.value });
      continue;
    }
    if (!isElement(node)) continue;
    const bind = attr(node, 'data-genki-bind');
    if (bind !== undefined) segments.push({ bind });
    else if (node.tagName === 'br') segments.push({ text: ' ' });
    else if (node.tagName === 'svg' || node.tagName === 'math')
      ctx.notes.add('dropped', 'droppedElement', `${where} > ${node.tagName}`, {
        element: node.tagName,
      });
    else if (!['script', 'style', 'noscript', 'template'].includes(node.tagName)) {
      if (node.tagName === 'a' && root.tagName !== 'a')
        ctx.notes.add('text', 'linkAsText', `${where} > a`);
      pushChildren(node);
    }
  }
  return segments;
};

const hasLetters = /\p{L}/u;

const literalOrKey = (text: string, ctx: Context): TextPart =>
  !hasLetters.test(text) && text.length <= templateLimits.literal
    ? text
    : { t: ctx.texts.keyFor(text) };

/** Text and bindings as a template text: words as bokmål text keys, data as bindings. */
const textFrom = (segments: Segment[], ctx: Context, where: string): TemplateText | undefined => {
  const parts: (string | TextPart)[] = [];
  const pushText = (text: string) => {
    const last = parts.at(-1);
    if (typeof last === 'string') parts[parts.length - 1] = last + text;
    else parts.push(text);
  };
  for (const segment of segments) {
    if ('bind' in segment) {
      const bound = bindOf(segment.bind, ctx);
      if (bound) parts.push(bound);
      else {
        ctx.notes.add('data', 'bindOutsideFields', where, { path: segment.bind.slice(0, 160) });
        pushText(`{{ ${segment.bind} }}`);
      }
      continue;
    }
    let last = 0;
    for (const match of segment.text.matchAll(bindPattern)) {
      pushText(segment.text.slice(last, match.index));
      last = match.index + match[0].length;
      const bound = bindOf(match[1] ?? '', ctx);
      if (bound) parts.push(bound);
      else {
        ctx.notes.add('data', 'bindOutsideFields', where, { path: match[1] ?? '' });
        pushText(match[0]);
      }
    }
    pushText(segment.text.slice(last));
  }
  const cleaned = parts
    .map((part) => (typeof part === 'string' ? part.replace(/\s+/g, ' ') : part))
    .map((part, i, all) => {
      if (typeof part !== 'string') return part;
      const first = i === 0 ? part.trimStart() : part;
      return i === all.length - 1 ? first.trimEnd() : first;
    })
    .filter((part) => part !== '');
  if (cleaned.length === 0) return undefined;
  if (cleaned.length <= templateLimits.textParts) {
    const text = cleaned.map((part) => (typeof part === 'string' ? literalOrKey(part, ctx) : part));
    return text.length === 1 ? text[0] : text;
  }
  const args: Record<string, string> = {};
  const words = cleaned
    .map((part) => {
      if (typeof part === 'string') return part;
      const path = (part as { bind: string }).bind;
      const name = `v${Object.keys(args).length + 1}`;
      if (Object.keys(args).length >= 8) {
        ctx.notes.add('data', 'bindOutsideFields', where, { path });
        return `{{ ${path} }}`;
      }
      args[name] = path;
      return `{${name}}`;
    })
    .join('');
  return { t: ctx.texts.keyFor(words), args };
};

const textOfElement = (el: Element, ctx: Context, where: string) =>
  textFrom(segmentsOf(el, ctx, where), ctx, where);

const classesOf = (el: Element) => new Set((attr(el, 'class') ?? '').split(/\s+/).filter(Boolean));

const isFlexRow = (el: Element) => {
  const style = (attr(el, 'style') ?? '').toLowerCase();
  const classes = classesOf(el);
  const flexStyle = /display\s*:\s*(?:inline-)?flex/.test(style);
  const column = /flex-direction\s*:\s*column/.test(style) || classes.has('flex-col');
  return (flexStyle || classes.has('flex') || classes.has('row')) && !column;
};

const colorOf = <C extends string>(el: Element, allowed: readonly C[], fallback: C): C => {
  const color = attr(el, 'data-color') as C | undefined;
  return color && allowed.includes(color) ? color : fallback;
};

const headingLevel = (tag: string): 2 | 3 | 4 =>
  tag === 'h1' || tag === 'h2' ? 2 : tag === 'h3' ? 3 : 4;

const listField = (path: string) => fieldOf(path)?.type === 'list' && !path.includes('.');

/** The template nodes for the children of a container, inline runs as paragraphs. */
const childrenNodes = (el: Element, ctx: Context, where: string): TemplateNode[] => {
  const nodes: TemplateNode[] = [];
  let run: ChildNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const segments = run.flatMap((node): Segment[] =>
      isText(node) ? [{ text: node.value }] : segmentsOf(node as Element, ctx, where),
    );
    run = [];
    const text = textFrom(segments, ctx, where);
    if (text) nodes.push({ type: 'paragraph', text });
  };
  const inner = childrenOf(el);
  const counts = new Map<string, number>();
  for (const child of inner) {
    const bound = isElement(child) && attr(child, 'data-genki-bind') !== undefined;
    if (bound || (isInline(child) && !(isElement(child) && child.tagName === 'a'))) {
      run.push(child);
      continue;
    }
    flush();
    if (!isElement(child)) continue;
    const index = counts.get(child.tagName) ?? 0;
    counts.set(child.tagName, index + 1);
    nodes.push(
      ...convert(child, ctx, `${where} > ${child.tagName}${index > 0 ? `[${index + 1}]` : ''}`),
    );
  }
  flush();
  return nodes;
};

const linkNode = (el: Element, ctx: Context, where: string): TemplateNode[] => {
  const href = attr(el, 'href') ?? '';
  const text = textOfElement(el, ctx, where);
  if (isHttpsAddress(href))
    return [{ type: 'link', href, text: text ?? { t: ctx.texts.keyFor(href) } }];
  ctx.notes.add('dropped', 'droppedLink', where);
  return text ? [{ type: 'paragraph', text }] : [];
};

const buttonNode = (el: Element, ctx: Context, where: string): TemplateNode[] => {
  const text = textOfElement(el, ctx, where);
  if (!text) return [];
  const event = attr(el, 'data-genki-event');
  const page = attr(el, 'data-genki-page') ?? '';
  const variant = attr(el, 'data-variant');
  const look: { variant: 'primary' | 'secondary' | 'tertiary' } = {
    variant: variant === 'primary' || variant === 'tertiary' ? variant : 'secondary',
  };
  if (event === 'ask') {
    ctx.events.add('ask');
    return [{ type: 'button', ...look, text, event: { name: 'ask', question: text } }];
  }
  if (event === 'notify') {
    ctx.events.add('notify');
    return [{ type: 'button', ...look, text, event: { name: 'notify', text } }];
  }
  if (event === 'open-page' && templatePagePattern.test(page)) {
    ctx.events.add('open-page');
    return [{ type: 'button', ...look, text, event: { name: 'open-page', page } }];
  }
  ctx.notes.add('text', 'buttonWithoutEvent', where);
  return [{ type: 'paragraph', text }];
};

const rowsOf = (table: Element) =>
  elementsOf(table).flatMap((child) =>
    child.tagName === 'tr'
      ? [child]
      : ['thead', 'tbody', 'tfoot'].includes(child.tagName)
        ? elementsOf(child).filter((row) => row.tagName === 'tr')
        : [],
  );

const cellsOf = (row: Element) =>
  elementsOf(row).filter((cell) => cell.tagName === 'td' || cell.tagName === 'th');

const tableNode = (el: Element, ctx: Context, where: string): TemplateNode[] => {
  const caption = elementsOf(el).find((child) => child.tagName === 'caption');
  const title = caption && textOfElement(caption, ctx, `${where} > caption`);
  const body = tableBody(el, ctx, where);
  return title ? [{ type: 'paragraph', text: title }, ...body] : body;
};

const tableBody = (el: Element, ctx: Context, where: string): TemplateNode[] => {
  const rows = rowsOf(el);
  const cells = rows.map(cellsOf);
  if (
    rows.length > 0 &&
    rows.length <= templateLimits.keyValueItems &&
    cells.every((row) => row.length === 2)
  ) {
    const items = cells.flatMap(([key, value], i) => {
      const k = textOfElement(key as Element, ctx, `${where} > tr[${i + 1}]`);
      const v = textOfElement(value as Element, ctx, `${where} > tr[${i + 1}]`);
      return k && v ? [{ key: k, value: v }] : [];
    });
    return items.length > 0 ? [{ type: 'keyValue', items }] : [];
  }
  const children = cells.flatMap((row, i): TemplateNode[] => {
    const texts = row.flatMap((cell) => {
      const text = textOfElement(cell, ctx, `${where} > tr[${i + 1}]`);
      return text ? [{ type: 'paragraph' as const, text }] : [];
    });
    return texts.length > 0 ? [{ type: 'row', children: texts }] : [];
  });
  return children.length > 0 ? [{ type: 'stack', children }] : [];
};

const detailsNode = (el: Element, ctx: Context, where: string): TemplateNode[] => {
  const summaryElement = elementsOf(el).find((child) => child.tagName === 'summary');
  const summary =
    (summaryElement && textOfElement(summaryElement, ctx, `${where} > summary`)) ?? '+';
  const rest = { ...el, childNodes: childrenOf(el).filter((child) => child !== summaryElement) };
  return [
    {
      type: 'details',
      summary,
      ...(attr(el, 'open') !== undefined ? { open: true } : {}),
      children: childrenNodes(rest, ctx, where),
    },
  ];
};

const containerNode = (el: Element, ctx: Context, where: string): TemplateNode[] => {
  const classes = classesOf(el);
  if (classes.has('ds-alert')) {
    const text = textOfElement(el, ctx, where);
    const color = colorOf(el, ['info', 'success', 'warning', 'danger'] as const, 'info');
    return text ? [{ type: 'alert', color, text }] : [];
  }
  if (classes.has('ds-tag')) {
    const text = textOfElement(el, ctx, where);
    const colors = ['neutral', 'info', 'success', 'warning', 'danger', 'accent'] as const;
    return text ? [{ type: 'tag', color: colorOf(el, colors, 'neutral'), text }] : [];
  }
  const children = childrenNodes(el, ctx, where);
  if (classes.has('ds-card')) return [{ type: 'card', children }];
  if (children.length === 0) return [];
  if (isFlexRow(el)) return [{ type: 'row', children }];
  return children.length === 1 ? children : [{ type: 'stack', children }];
};

const convertElement = (el: Element, ctx: Context, where: string): TemplateNode[] => {
  const tag = el.tagName;
  if (designClasses.test(attr(el, 'class') ?? '')) return containerNode(el, ctx, where);
  if (attr(el, 'data-genki-bind') !== undefined || (inlineTags.has(tag) && tag !== 'a')) {
    const text = textOfElement(el, ctx, where);
    return text ? [{ type: 'paragraph', text }] : [];
  }
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const text = textOfElement(el, ctx, where);
      return text ? [{ type: 'heading', level: headingLevel(tag), text }] : [];
    }
    case 'p':
    case 'pre':
    case 'caption':
    case 'legend': {
      const text = textOfElement(el, ctx, where);
      return text ? [{ type: 'paragraph', text }] : [];
    }
    case 'ul':
    case 'ol':
    case 'menu': {
      const items = elementsOf(el).flatMap((li, i) =>
        li.tagName === 'li' || attr(li, 'data-genki-each') !== undefined
          ? convert(li, ctx, `${where} > li[${i + 1}]`)
          : [],
      );
      return items.length > 0 ? [{ type: 'list', ordered: tag === 'ol', items }] : [];
    }
    case 'li': {
      const blocks = elementsOf(el).some((child) => !inlineTags.has(child.tagName));
      if (blocks) return containerNode(el, ctx, where);
      const text = textOfElement(el, ctx, where);
      return text ? [{ type: 'paragraph', text }] : [];
    }
    case 'a':
      return linkNode(el, ctx, where);
    case 'button':
      return buttonNode(el, ctx, where);
    case 'table':
      return tableNode(el, ctx, where);
    case 'details':
      return detailsNode(el, ctx, where);
    case 'hr':
      return [{ type: 'divider' }];
    case 'script':
    case 'link':
    case 'style':
    case 'base':
      return [];
    case 'svg':
    case 'math':
      ctx.notes.add('dropped', 'droppedElement', where, { element: tag });
      return [];
    default:
      return silent.has(tag) ? [] : containerNode(el, ctx, where);
  }
};

/** An element as template nodes, wrapped in an each when the design repeats it over a list. */
export const convert = (el: Element, ctx: Context, where: string): TemplateNode[] => {
  const of = attr(el, 'data-genki-each');
  if (of === undefined) return convertElement(el, ctx, where);
  if (ctx.each || !listField(of)) {
    ctx.notes.add('data', 'eachOutsideFields', where, { path: of.slice(0, 160) });
    return convertElement(el, ctx, where);
  }
  const children = convertElement(el, { ...ctx, each: { of, as: 'item' } }, where);
  if (children.length === 0) return [];
  ctx.reads.add(of);
  const wanted = Number(attr(el, 'data-genki-max'));
  const max =
    Number.isInteger(wanted) && wanted >= 1 && wanted <= templateLimits.eachMax
      ? wanted
      : templateLimits.eachDefault;
  return [{ type: 'each', of, as: 'item', max, children }];
};

export const bodyNodes = (body: Element, ctx: Context) => childrenNodes(body, ctx, 'body');

/** The zones every field the block reads is given in; the main column when nothing narrows it. */
export const zonesFor = (reads: Iterable<string>): BlockZone[] => {
  let zones: BlockZone[] = [...blockZones];
  for (const path of reads) {
    const own = fieldOf(path)?.zones;
    if (own) zones = zones.filter((zone) => own.includes(zone));
  }
  if (zones.includes('main')) return ['main'];
  return zones.length > 0 ? zones : ['main'];
};
