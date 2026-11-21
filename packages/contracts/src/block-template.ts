import type { BlockState } from './blocks.js';

export const templateLimits = {
  bytes: 32 * 1024,
  nodes: 200,
  depth: 12,
  jsonDepth: 64,
  listNesting: 2,
  eachMax: 50,
  eachDefault: 10,
  drawn: 2000,
  columns: 8,
  textParts: 8,
  literal: 8,
  paths: 200,
  conditionDepth: 3,
  keyValueItems: 20,
  filterValues: 50,
  filterValue: 200,
} as const;

export const templateElements = [
  'stack',
  'row',
  'card',
  'details',
  'heading',
  'paragraph',
  'list',
  'link',
  'button',
  'tag',
  'alert',
  'divider',
  'icon',
  'table',
  'keyValue',
  'each',
  'if',
] as const;

export type TemplateElement = (typeof templateElements)[number];

/** The Aksel icons a template may name, in kebab case. */
export const templateIcons = [
  'information-square',
  'exclamationmark-triangle',
  'checkmark-circle',
  'x-mark-octagon',
  'questionmark-circle',
  'file-text',
  'file-search',
  'book',
  'link',
  'external-link',
  'chat',
  'robot',
  'calendar',
  'clock',
  'bookmark',
  'star',
  'tag',
  'person',
  'buildings3',
] as const;

export type TemplateIcon = (typeof templateIcons)[number];

export const templatePathPattern = /^[a-z][a-zA-Z0-9]{0,31}(?:\.[a-z][a-zA-Z0-9]{0,31}){0,4}$/;
export const templateAliasPattern = /^[a-z][a-zA-Z0-9]{0,15}$/;
export const templatePagePattern = /^[a-z][a-z0-9-]{0,63}$/;

export type TemplatePath = string;

export type TextPart =
  | string
  | { t: string; args?: Record<string, TemplatePath | { count: TemplatePath }> }
  | { bind: TemplatePath; format?: 'plain' | 'date' | 'number' }
  | { count: TemplatePath };

export type TemplateText = TextPart | TextPart[];

export type TemplateHref = string | { bind: TemplatePath } | { page: string };

export type TemplateAction =
  | { name: 'ask'; question: TemplateText }
  | { name: 'open-document'; source: TemplatePath }
  | { name: 'set-filter'; field: string; values: TemplatePath | string[] }
  | { name: 'open-page'; page: string }
  | { name: 'notify'; text: TemplateText };

export type TemplateCondition =
  | { exists: TemplatePath }
  | { empty: TemplatePath }
  | { equals: [TemplatePath, string | number | boolean] }
  | { state: BlockState }
  | { not: TemplateCondition };

export type Gap = 'none' | 'sm' | 'md' | 'lg';

export type TemplateNode =
  | { type: 'stack'; gap?: Gap; children: TemplateNode[] }
  | {
      type: 'row';
      gap?: Gap;
      wrap?: boolean;
      align?: 'start' | 'center' | 'end' | 'baseline';
      children: TemplateNode[];
    }
  | { type: 'card'; variant?: 'default' | 'tinted'; children: TemplateNode[] }
  | { type: 'details'; summary: TemplateText; open?: boolean; children: TemplateNode[] }
  | { type: 'heading'; level: 2 | 3 | 4; size?: '2xs' | 'xs' | 'sm' | 'md'; text: TemplateText }
  | { type: 'paragraph'; size?: 'sm' | 'md'; variant?: 'default' | 'subtle'; text: TemplateText }
  | { type: 'list'; ordered?: boolean; items: TemplateNode[] }
  | { type: 'link'; href: TemplateHref; text: TemplateText }
  | {
      type: 'button';
      variant?: 'primary' | 'secondary' | 'tertiary';
      text: TemplateText;
      event: TemplateAction;
    }
  | {
      type: 'tag';
      color?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
      text: TemplateText;
    }
  | { type: 'alert'; color: 'info' | 'success' | 'warning' | 'danger'; text: TemplateText }
  | { type: 'divider' }
  | { type: 'icon'; name: TemplateIcon; label?: TemplateText }
  | {
      type: 'table';
      rows: TemplatePath;
      as: string;
      max?: number;
      columns: { header: TemplateText; cell: TemplateNode }[];
    }
  | { type: 'keyValue'; items: { key: TemplateText; value: TemplateText }[] }
  | { type: 'each'; of: TemplatePath; as: string; max?: number; children: TemplateNode[] }
  | { type: 'if'; when: TemplateCondition; then: TemplateNode[]; else?: TemplateNode[] };

export interface BlockTemplate {
  version: 1;
  root: TemplateNode;
  states?: Partial<Record<BlockState, TemplateNode>>;
}

/** What a declarative block sends its host when the person acts on it. */
export type TemplateEvent =
  | { name: 'ask'; question: string }
  | { name: 'open-document'; index: number }
  | { name: 'set-filter'; field: string; values: string[] }
  | { name: 'open-page'; page: string }
  | { name: 'notify'; text: string };

/** An https address with a host name, no credentials and no spaces or backslashes. */
export const isHttpsAddress = (link: string) => {
  if (link.length > 2_000 || !link.startsWith('https://')) return false;
  const rest = link.slice('https://'.length);
  const hostEnd = rest.search(/[/?#]/);
  const host = hostEnd < 0 ? rest : rest.slice(0, hostEnd);
  return /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*(?::\d{1,5})?$/.test(host) && !/[\s\\]/.test(rest);
};

/** A path on the host's own site: one leading slash, no scheme, no spaces or backslashes. */
export const isSitePath = (link: string) =>
  link.length <= 2_000 && /^\/(?![/\\])[^\\\s]*$/.test(link);

/** How many elements a template draws at most, each node counted once per row its lists repeat it. */
export const templateDrawn = (template: BlockTemplate): number => {
  const roots = [template.root, ...Object.values(template.states ?? {})];
  const stack = roots.flatMap((node) => (node ? [{ node, times: 1 }] : []));
  let drawn = 0;
  while (stack.length > 0) {
    const { node, times } = stack.pop() as (typeof stack)[number];
    drawn += times;
    const inner = (nodes: TemplateNode[], by = times) =>
      nodes.forEach((child) => stack.push({ node: child, times: by }));
    const rows = (max: number | undefined) =>
      times * Math.min(max ?? templateLimits.eachDefault, templateLimits.eachMax);
    switch (node.type) {
      case 'stack':
      case 'row':
      case 'card':
      case 'details':
        inner(node.children);
        break;
      case 'list':
        inner(node.items);
        break;
      case 'if':
        inner([...node.then, ...(node.else ?? [])]);
        break;
      case 'each':
        inner(node.children, rows(node.max));
        break;
      case 'table':
        drawn += times * node.columns.length;
        inner(
          node.columns.map((column) => column.cell),
          rows(node.max),
        );
        break;
      case 'keyValue':
        drawn += times * node.items.length;
        break;
    }
  }
  return drawn;
};
