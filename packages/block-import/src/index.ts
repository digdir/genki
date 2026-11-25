import type { BlockEvent } from '@genai/contracts/blocks';
import { templateLimits, type BlockTemplate } from '@genai/contracts/block-template';
import { validateDefinition, type PluginSchemas } from '@genai/definitions';
import { parse } from 'parse5';
import { bodyNodes, textKeys, zonesFor, type Context } from './declarative.js';
import { findings, type Findings, type ImportFinding } from './report.js';
import {
  attr,
  childrenOf,
  findElement,
  isElement,
  isText,
  textOf,
  walk,
  type ChildNode,
  type Element,
  type ParentNode,
} from './tree.js';

export {
  importNoteCodes,
  type ImportFinding,
  type ImportNoteCode,
  type ImportNoteKind,
} from './report.js';

export const importLimits = {
  htmlBytes: 512 * 1024,
  nodes: templateLimits.nodes,
  depth: templateLimits.depth,
  iconBytes: 2 * 1024,
  title: 80,
} as const;

export const importRefusals = [
  'tooLarge',
  'empty',
  'tooMuchText',
  'codeScript',
  'codeAnimation',
  'codeElement',
  'codeLimits',
  'codeInvalid',
] as const;

export type ImportRefusal = (typeof importRefusals)[number];

/** A design genki cannot turn into a block without code, by a stable code. */
export class ImportRefused extends Error {
  constructor(
    readonly code: ImportRefusal,
    readonly values: Record<string, string | number> = {},
  ) {
    super(`the design cannot be imported: ${code}`);
  }
}

export interface ImportOptions {
  tenant: string;
  id: string;
  title?: string | undefined;
}

export interface ImportedBlock {
  apiVersion: 'genai/v1';
  kind: 'Block';
  metadata: { tenant: string; id: string; name: string };
  spec: {
    tier: 'declarative';
    title: { nb: string };
    zones: string[];
    sharing: 'organisation';
    events: BlockEvent[];
    states: string[];
    texts?: { nb: Record<string, string> };
    template: BlockTemplate;
  };
}

/** A proposed first edition; nothing is saved. */
export interface ImportProposal {
  tier: 'declarative';
  definition: ImportedBlock;
  files: Record<string, string>;
  report: ImportFinding[];
}

const noPlugins: PluginSchemas = {
  strategies: new Map(),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  models: new Map(),
};

const triggerTags = new Set([
  'canvas',
  'img',
  'picture',
  'video',
  'audio',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'select',
  'textarea',
]);

const motion = /@keyframes|\btransition\s*:|\banimation\s*:/i;
const hexColour = /#[0-9a-fA-F]{3,8}\b/;

const sizeOver = (root: Element, max: number) => {
  let bytes = 0;
  const stack: ChildNode[] = [root];
  while (stack.length > 0 && bytes <= max) {
    const node = stack.pop() as ChildNode;
    if (isText(node)) bytes += node.value.length;
    else if (isElement(node)) {
      bytes += node.tagName.length * 2 + 5;
      for (const a of node.attrs) bytes += a.name.length + a.value.length + 4;
      for (const child of childrenOf(node)) stack.push(child);
    }
  }
  return bytes > max;
};

interface Scan {
  nodes: number;
  depth: number;
  styled?: boolean;
  coloured?: boolean;
  external?: boolean;
  trigger?: string | undefined;
}

/** One pass over the design: its size, and the first thing only code can draw. */
const scan = (document: ParentNode, body: Element, notes: Findings): Scan => {
  const result: Scan = { nodes: 0, depth: 0 };
  const triggered = (what: string) => {
    result.trigger ??= what;
  };
  let coloured = false;
  walk(document, (el) => {
    if (el.tagName === 'script' && attr(el, 'src') !== undefined) {
      result.external = true;
      notes.add('dropped', 'droppedScript', el.tagName);
    }
    if (el.tagName === 'script' && attr(el, 'src') === undefined && textOf(el).trim() !== '')
      triggered('script');
    if (el.tagName === 'link') notes.add('dropped', 'droppedStylesheet', el.tagName);
    if (el.tagName === 'base') notes.add('dropped', 'droppedBase', el.tagName);
    if (el.tagName === 'style') {
      result.styled = true;
      const css = childrenOf(el)
        .filter(isText)
        .map((t) => t.value)
        .join('');
      if (motion.test(css)) triggered('animation');
      coloured ||= hexColour.test(css);
    }
  });
  walk(body, (el, depth) => {
    result.nodes += 1;
    result.depth = Math.max(result.depth, depth);
    if (triggerTags.has(el.tagName)) triggered(el.tagName);
    if (el.tagName === 'svg') {
      const parent = el.parentNode as Element | null;
      const placed = parent && /^(button|h[1-6])$/.test(parent.tagName);
      if (!result.trigger && (!placed || sizeOver(el, importLimits.iconBytes))) triggered('svg');
    }
    if (el.attrs.some((a) => a.name.startsWith('on')))
      notes.add('dropped', 'droppedHandler', el.tagName);
    const style = attr(el, 'style');
    if (style !== undefined) {
      result.styled = true;
      if (motion.test(style)) triggered('animation');
      coloured ||= hexColour.test(style);
    }
  });
  result.coloured = coloured;
  return result;
};

const titleFrom = (document: ParentNode, options: ImportOptions) => {
  const given = options.title?.trim();
  const head = findElement(document, 'head');
  const titleElement = head && findElement(head, 'title');
  const found = titleElement ? textOf(titleElement).replace(/\s+/g, ' ').trim() : '';
  return (given || found || options.id).slice(0, importLimits.title);
};

const declarative = (
  body: Element,
  options: ImportOptions,
  title: string,
  notes: Findings,
): ImportedBlock | { invalid: string } => {
  const ctx: Context = {
    notes,
    texts: textKeys(),
    events: new Set(),
    reads: new Set(),
  };
  const nodes = bodyNodes(body, ctx);
  if (ctx.texts.overflow) return { invalid: 'texts' };
  if (nodes.length === 0) return { invalid: 'empty' };
  const root =
    nodes.length === 1 && nodes[0] ? nodes[0] : { type: 'stack' as const, children: nodes };
  const texts = ctx.texts.nb;
  const definition: ImportedBlock = {
    apiVersion: 'genai/v1',
    kind: 'Block',
    metadata: { tenant: options.tenant, id: options.id, name: title },
    spec: {
      tier: 'declarative',
      title: { nb: title },
      zones: zonesFor(ctx.reads),
      sharing: 'organisation',
      events: [...ctx.events],
      states: [],
      ...(Object.keys(texts).length > 0 ? { texts: { nb: texts } } : {}),
      template: { version: 1, root },
    },
  };
  const checked = validateDefinition(definition, noPlugins);
  return checked.ok ? definition : { invalid: checked.errors[0]?.path ?? 'spec' };
};

const bytesOf = (text: string) => Buffer.byteLength(text, 'utf8');

const needsCode = (trigger: string) =>
  trigger === 'script'
    ? new ImportRefused('codeScript')
    : trigger === 'animation'
      ? new ImportRefused('codeAnimation')
      : new ImportRefused('codeElement', { element: trigger });

/** Turn a design's HTML into a proposed declarative block, or refuse with why it needs code. */
export const importDesign = (html: string, options: ImportOptions): ImportProposal => {
  if (bytesOf(html) > importLimits.htmlBytes) throw new ImportRefused('tooLarge');
  const document = parse(html);
  const body = findElement(document, 'body');
  if (!body) throw new ImportRefused('empty');
  const notes = findings();
  const title = titleFrom(document, options);
  const scanned = scan(document, body, notes);
  if (scanned.trigger) throw needsCode(scanned.trigger);
  const nothing = scanned.external ? needsCode('script') : new ImportRefused('empty');
  if (textOf(body).trim() === '' && !childrenOf(body).some(isElement)) throw nothing;
  if (scanned.nodes > importLimits.nodes || scanned.depth > importLimits.depth)
    throw new ImportRefused('codeLimits', { nodes: scanned.nodes, depth: scanned.depth });
  const result = declarative(body, options, title, notes);
  if ('invalid' in result)
    throw result.invalid === 'empty'
      ? nothing
      : result.invalid === 'texts'
        ? new ImportRefused('tooMuchText')
        : new ImportRefused('codeInvalid', { path: result.invalid });
  if (scanned.styled) notes.add('dropped', 'droppedStyle', 'style');
  if (scanned.coloured) notes.add('dropped', 'colours', 'style');
  if (result.spec.texts) notes.add('text', 'englishLeftOut', 'spec.texts');
  notes.add('converted', 'convertedDeclarative', 'body');
  return { tier: 'declarative', definition: result, files: {}, report: notes.list() };
};
