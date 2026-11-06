import { Table } from '@digdir/designsystemet-react';
import { Fragment, type ReactNode } from 'react';
import { runsIn, type SearchHit } from './textSearch.js';

/**
 * Called with every plain string this renderer puts in the document, in document order. It is how
 * the search marks a hit without the caller having to know the markup: the same walk produces the
 * text that is searched (`visibleLeaves`) and the text that is drawn, so the two can never drift.
 */
export type Leaf = (text: string, key: string) => ReactNode;

/**
 * Called where the drawing breaks a line — between two blocks. Two leaves inside one block have
 * nothing between them on screen, so a query runs straight across a `<strong>`; two blocks have a
 * line, so it cannot run across them. Only the collecting walk uses it.
 */
export type Gap = () => void;

const plain: Leaf = (text) => text;

export type Align = 'left' | 'center' | 'right' | undefined;

export type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] };

const bullet = /^\s*[-*+]\s+(.*)$/;
const numbered = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const fence = /^\s*```/;
const delimiterCell = /^\s*:?-+:?\s*$/;

export const cellsOf = (line: string): string[] => {
  const trimmed = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
};

const alignOf = (cell: string): Align => {
  const c = cell.trim();
  if (c.startsWith(':') && c.endsWith(':')) return 'center';
  if (c.endsWith(':')) return 'right';
  if (c.startsWith(':')) return 'left';
  return undefined;
};

const tableAt = (lines: string[], i: number) => {
  const header = lines[i] ?? '';
  const delimiter = lines[i + 1] ?? '';
  if (!header.includes('|') || !delimiter.includes('|')) return undefined;
  const head = cellsOf(header);
  const rule = cellsOf(delimiter);
  if (rule.length !== head.length || !rule.every((c) => delimiterCell.test(c))) return undefined;
  const rows: string[][] = [];
  let end = i + 2;
  while (end < lines.length && (lines[end] ?? '').includes('|') && (lines[end] ?? '').trim()) {
    rows.push(cellsOf(lines[end] ?? ''));
    end += 1;
  }
  return { block: { kind: 'table' as const, head, align: rule.map(alignOf), rows }, end };
};

export const blocksOf = (text: string): Block[] => {
  const blocks: Block[] = [];
  let open: Block | undefined;
  const close = () => {
    if (open) blocks.push(open);
    open = undefined;
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (open?.kind === 'code') {
      if (fence.test(line)) close();
      else open.text = open.text ? `${open.text}\n${line}` : line;
      continue;
    }
    if (fence.test(line)) {
      close();
      open = { kind: 'code', text: '' };
      continue;
    }
    if (!line.trim()) {
      close();
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      close();
      blocks.push(table.block);
      i = table.end - 1;
      continue;
    }
    const title = heading.exec(line);
    const item = bullet.exec(line);
    const step = item ? undefined : numbered.exec(line);
    if (title) {
      close();
      blocks.push({ kind: 'heading', text: title[1] ?? '' });
    } else if (item || step) {
      const ordered = Boolean(step);
      const content = (item ? item[1] : step?.[2]) ?? '';
      if (open?.kind !== 'list' || open.ordered !== ordered) {
        close();
        open = { kind: 'list', ordered, start: step ? Number(step[1]) : 1, items: [] };
      }
      open.items.push(content);
    } else if (open?.kind === 'list' && /^\s/.test(line)) {
      open.items[open.items.length - 1] += ` ${line.trim()}`;
    } else if (open?.kind === 'paragraph') {
      open.lines.push(line);
    } else {
      close();
      open = { kind: 'paragraph', lines: [line] };
    }
  }
  close();
  return blocks;
};

const destination = String.raw`\((?:[^()\s]|\([^()\s]*\))*\)`;
const inlinePattern = new RegExp(
  `(${[
    String.raw`\\[!-\/:-@\[-\x60{-~]`,
    String.raw`\x60[^\x60\n]+\x60`,
    String.raw`!\[[^\]\n]*\]${destination}`,
    String.raw`\[[^\]\n]+\]${destination}`,
    String.raw`\[\d+(?:\s*,\s*\d+)*\]`,
    String.raw`<https?:\/\/[^<>\s]+>`,
    String.raw`<sup>[^<\n]*<\/sup>|<sub>[^<\n]*<\/sub>|<br\s*\/?>`,
    String.raw`\*\*[^\n]+?\*\*`,
    String.raw`(?<![\p{L}\p{N}_\\])__(?=[^_\s])[^\n]*?[^_\s\\]__(?![\p{L}\p{N}_])`,
    String.raw`~~(?=[^~\s])[^~\n]*?[^~\s\\]~~`,
    String.raw`(?<![\p{L}\p{N}*\\])\*(?=[^*\s])[^*\n]*?[^*\s\\]\*(?![\p{L}\p{N}*])`,
    String.raw`(?<![\p{L}\p{N}_\\])_(?=[^_\s])[^_\n]*?[^_\s\\]_(?![\p{L}\p{N}_])`,
  ].join('|')})`,
  'u',
);

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi;

// Drawn as text after the markup is read, so `&lt;b&gt;` shows the characters.
export const decodeEntities = (text: string) =>
  text.replace(ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    const code = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });

export type CiteRenderer = (n: number, key: string) => ReactNode | undefined;

const citation = (n: number, key: string, cite: CiteRenderer): ReactNode =>
  cite(n, key) ?? `[${n}]`;

const markup = (
  part: string,
  cite: CiteRenderer,
  k: string,
  links: boolean,
  leaf: Leaf,
): ReactNode => {
  if (part.startsWith('\\')) return part.slice(1);
  if (part.startsWith('`')) return <code key={k}>{leaf(part.slice(1, -1), `${k}-c`)}</code>;
  const image = /^!\[([^\]]*)\]/.exec(part);
  if (image) return decodeEntities(image[1] ?? '');
  const tag = /^<(sup|sub)>([^<\n]*)<\/\1>$/.exec(part);
  if (tag)
    return tag[1] === 'sup' ? (
      <sup key={k}>{inline(tag[2] ?? '', cite, k, links, leaf)}</sup>
    ) : (
      <sub key={k}>{inline(tag[2] ?? '', cite, k, links, leaf)}</sub>
    );
  if (part.startsWith('<http')) {
    const href = part.slice(1, -1);
    if (!links) return href;
    return (
      <a key={k} href={href} target="_blank" rel="noopener noreferrer">
        {href}
      </a>
    );
  }
  if (part.startsWith('<')) return <br key={k} />;
  const link = /^\[([^\]]+)\]\((.*)\)$/.exec(part);
  if (link) {
    const href = decodeEntities(link[2] ?? '');
    const label = inline(link[1] ?? '', cite, k, links, leaf);
    return links && /^https?:\/\//i.test(href) ? (
      <a key={k} href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    ) : (
      <Fragment key={k}>{label}</Fragment>
    );
  }
  const cites = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part);
  if (cites) {
    const numbers = (cites[1] ?? '').split(',').map((n) => Number(n.trim()));
    return numbers.length === 1 ? (
      citation(numbers[0] ?? 0, k, cite)
    ) : (
      <span key={k}>{numbers.map((n, j) => [j ? ' ' : '', citation(n, `${k}-${j}`, cite)])}</span>
    );
  }
  if (part.startsWith('**') || part.startsWith('__'))
    return <strong key={k}>{inline(part.slice(2, -2), cite, k, links, leaf)}</strong>;
  if (part.startsWith('~~'))
    return <del key={k}>{inline(part.slice(2, -2), cite, k, links, leaf)}</del>;
  return <em key={k}>{inline(part.slice(1, -1), cite, k, links, leaf)}</em>;
};

// With `links` false, a link is drawn as its words and an autolink as its address. Every piece
// that comes out of this as a plain string goes through `leaf`, which is what lets the search mark
// it; a piece the caller turned into an element of its own is the caller's to handle.
export const inline = (
  text: string,
  cite: CiteRenderer,
  key = 'i',
  links = true,
  leaf: Leaf = plain,
): ReactNode[] =>
  text
    .split(inlinePattern)
    .map((part, i) => {
      // One pass, in document order: `markup` can call `inline` again, so a second pass over the
      // results would hand a nested leaf over before the plain text that comes in front of it.
      if (i % 2 === 0) {
        const value = decodeEntities(part);
        return value === '' ? '' : leaf(value, `${key}-l${i}`);
      }
      const node = markup(part, cite, `${key}-${i}`, links, leaf);
      if (typeof node !== 'string') return node;
      return node === '' ? '' : leaf(node, `${key}-m${i}`);
    })
    .filter((part) => part !== '');

const noCitation: CiteRenderer = () => undefined;

/**
 * The blocks of one text as elements. Pulled out of the component so the search can walk the very
 * same code with a collecting `leaf` (`visibleLeaves`): one walk, so the text that is searched and
 * the text that is drawn cannot drift apart.
 */
export const renderBlocks = (
  text: string,
  cite: CiteRenderer,
  links: boolean,
  leaf: Leaf,
  gap?: Gap,
): ReactNode[] =>
  blocksOf(text).map((block, i) => {
    const k = `b${i}`;
    if (i > 0) gap?.();
    if (block.kind === 'heading')
      return (
        <p key={k} className="uib-markdown-heading">
          <strong>{inline(block.text, cite, k, links, leaf)}</strong>
        </p>
      );
    if (block.kind === 'code')
      return (
        <pre key={k}>
          <code>{leaf(block.text, `${k}-c`)}</code>
        </pre>
      );
    if (block.kind === 'table')
      return (
        <Table key={k} data-size="sm" className="uib-markdown-table">
          <Table.Head>
            <Table.Row>
              {block.head.map((cell, j) =>
                cell ? (
                  <Table.HeaderCell key={j} scope="col" data-align={block.align[j]}>
                    {inline(cell, cite, `${k}-h${j}`, links, leaf)}
                  </Table.HeaderCell>
                ) : (
                  <Table.Cell key={j} />
                ),
              )}
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {block.rows.map((row, r) => (
              <Table.Row key={r}>
                {block.head.map((_, j) => (
                  <Table.Cell key={j} data-align={block.align[j]}>
                    {inline(row[j] ?? '', cite, `${k}-${r}-${j}`, links, leaf)}
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      );
    if (block.kind === 'list') {
      const items = block.items.map((item, j) => (
        <li key={j}>{inline(item, cite, `${k}-${j}`, links, leaf)}</li>
      ));
      return block.ordered ? (
        <ol key={k} {...(block.start === 1 ? {} : { start: block.start })}>
          {items}
        </ol>
      ) : (
        <ul key={k}>{items}</ul>
      );
    }
    return (
      <p key={k}>
        {block.lines.map((line, j) => [
          j ? <br key={`${k}-br${j}`} /> : null,
          ...inline(line, cite, `${k}-${j}`, links, leaf),
        ])}
      </p>
    );
  });

/** The words on screen, and where each drawn leaf starts in them. */
export interface VisibleText {
  /** What a reader can see and select, with a newline wherever the drawing breaks a line. */
  text: string;
  /** Where each leaf starts in `text`, in the order this renderer draws them. */
  offsets: number[];
}

/**
 * What this text is drawn as, with none of the syntax that produced it. The search indexes this,
 * not the Markdown behind it: `**viktig** tekst` is drawn as «viktig» and « tekst», so a search of
 * the source would find `viktig` at an offset that is nowhere on screen, and would find `**` as
 * text. It is the same walk `Markdown` renders with, so the two cannot drift apart.
 */
export const visibleText = (markdown: string, links = true): VisibleText => {
  let text = '';
  const offsets: number[] = [];
  renderBlocks(
    markdown,
    noCitation,
    links,
    (value) => {
      offsets.push(text.length);
      text += value;
      return value;
    },
    () => {
      text += '\n';
    },
  );
  return { text, offsets };
};

/** What the search hands the renderer, so it can mark its own leaves. */
export interface MarkdownHighlight {
  hits: readonly SearchHit[];
  /** Where each leaf starts in the flat text the hits were found in, in `visibleLeaves` order. */
  offsets: readonly number[];
  /** The hit the reader is standing on, by identity; it gets `data-current`. */
  current?: SearchHit | undefined;
  markClassName?: string | undefined;
}

export const Markdown = ({
  text,
  cite = noCitation,
  className = 'uib-markdown',
  links = true,
  highlight,
}: {
  text: string;
  cite?: CiteRenderer;
  className?: string;
  /** Whether a link is drawn as one; in a quotation it is text, whatever its syntax. */
  links?: boolean;
  /** Search hits to wrap in `<mark>`; without it the text is drawn as it always was. */
  highlight?: MarkdownHighlight | undefined;
}) => {
  // Counts the leaves of this one render, in the order `visibleLeaves` counted them.
  let at = 0;
  const leaf: Leaf =
    highlight === undefined
      ? plain
      : (value, key) => {
          const offset = highlight.offsets[at] ?? 0;
          at += 1;
          const runs = runsIn(value, offset, highlight.hits);
          if (runs.length === 1 && runs[0]?.hit === undefined) return value;
          return (
            <Fragment key={key}>
              {runs.map((run, i) =>
                run.hit ? (
                  <mark
                    key={i}
                    className={highlight.markClassName}
                    data-current={run.hit === highlight.current ? 'true' : undefined}
                  >
                    {run.text}
                  </mark>
                ) : (
                  run.text
                ),
              )}
            </Fragment>
          );
        };

  return <div className={className}>{renderBlocks(text, cite, links, leaf)}</div>;
};
