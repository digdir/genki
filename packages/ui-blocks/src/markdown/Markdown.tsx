import { Heading, Table } from '@digdir/designsystemet-react';
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
  | { kind: 'heading'; text: string; depth: number }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] };

// The text after the marker starts at its first non-space, so the run of spaces in front of it can
// be read only one way: a pattern where `\s+` and `.*` could share that run is quadratic in it.
const bullet = /^\s*[-*+]\s+(\S.*)?$/;
const numbered = /^\s*(\d{1,9})[.)]\s+(\S.*)?$/;
// A heading's text is what `.` matches: a line break other than `\n` in it makes the line text.
const oneLine = /^.*$/;

/**
 * The text and depth of a heading, or undefined when the line is not one: up to three spaces, one
 * to six `#` (the depth), at least one space, then the text, without a closing run of `#` and the
 * spaces around it. Read by hand, since a single pattern must try every way to share the spaces
 * between the text and the closing run, which is cubic in a long run of them.
 */
const headingOf = (line: string): { text: string; depth: number } | undefined => {
  const marks = line.trimStart();
  if (line.length - marks.length > 3) return undefined;
  let level = 0;
  while (marks[level] === '#') level += 1;
  const rest = marks.slice(level);
  const words = rest.trimStart();
  if (level < 1 || level > 6 || words === rest) return undefined;
  let end = words.trimEnd().length;
  while (end > 0 && words[end - 1] === '#') end -= 1;
  const text = words.slice(0, end).trimEnd();
  return oneLine.test(text) ? { text, depth: level } : undefined;
};

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
    const title = headingOf(line);
    const item = bullet.exec(line);
    const step = item ? undefined : numbered.exec(line);
    if (title !== undefined) {
      close();
      blocks.push({ kind: 'heading', text: title.text, depth: title.depth });
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

/**
 * What to draw for `[n]`: `undefined` leaves it as text, an element draws a footnote (held on the
 * line of the word before it), and `false` draws nothing, with the whitespace before it.
 */
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

const citesPart = /^\[\d+(?:\s*,\s*\d+)*\]$/;

/** Punctuation that closes the clause a footnote ends, held on the line of its marks. */
const closingPunctuation = /^[.,;:!?)\]»”’]+/u;

/**
 * A footnote the frontend draws as an element of its own stays on the line of the word before it:
 * a mark alone at the start of a line reads as belonging to nothing. Its run holds the last
 * character of that word, the marks and the punctuation after them. The whitespace the answer
 * wrote before a mark is kept for copying but not drawn, so the mark sets its own distance. A
 * footnote drawn as nothing (`false`) takes its whitespace with it. Only footnotes the caller drew
 * are touched, and a search over quotations never draws any, so the leaves it counts are the same.
 */
const holdFootnotes = (nodes: ReactNode[], footnotes: ReadonlySet<number>, key: string) => {
  if (footnotes.size === 0) return nodes;
  const out = [...nodes];
  const blank = (at: number) => typeof out[at] === 'string' && !(out[at] as string).trim();
  for (let start = 1; start < out.length; start += 2) {
    if (!footnotes.has(start)) continue;
    let end = start;
    while (footnotes.has(end + 2) && blank(end + 1)) end += 2;
    const marks: ReactNode[] = [];
    for (let at = start; at <= end; at += 2) {
      const between = at > start ? (out[at - 1] as string) : '';
      if (between && out[at] !== false)
        marks.push(
          <span key={`${key}-s${at}`} className="uib-markdown-cite-space">
            {between}
          </span>,
        );
      if (at > start) out[at - 1] = '';
      if (out[at] !== false) marks.push(out[at]);
      out[at] = '';
    }
    const before = out[start - 1];
    const words = typeof before === 'string' ? before.trimEnd() : undefined;
    if (marks.length === 0) {
      if (words !== undefined) out[start - 1] = words;
      start = end;
      continue;
    }
    const tail = words === undefined ? '' : (Array.from(words).at(-1) ?? '');
    const space =
      typeof before === 'string' && words !== undefined ? before.slice(words.length) : '';
    if (words !== undefined) out[start - 1] = words.slice(0, words.length - tail.length);
    const after = out[end + 1];
    const closing = typeof after === 'string' ? (closingPunctuation.exec(after)?.[0] ?? '') : '';
    if (closing) out[end + 1] = (after as string).slice(closing.length);
    out[start] = (
      <span key={`${key}-run${start}`} className="uib-markdown-cite-run">
        {tail}
        {space ? <span className="uib-markdown-cite-space">{space}</span> : null}
        <span className="uib-markdown-cite-marks">
          {marks}
          {closing}
        </span>
      </span>
    );
    start = end;
  }
  return out;
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
): ReactNode[] => {
  const footnotes = new Set<number>();
  const nodes = text.split(inlinePattern).map((part, i) => {
    // One pass, in document order: `markup` can call `inline` again, so a second pass over the
    // results would hand a nested leaf over before the plain text that comes in front of it.
    if (i % 2 === 0) {
      const value = decodeEntities(part);
      return value === '' ? '' : leaf(value, `${key}-l${i}`);
    }
    let drawn = false;
    const watched: CiteRenderer = (n, k) => {
      const node = cite(n, k);
      if (node !== undefined) drawn = true;
      return node;
    };
    const node = markup(part, citesPart.test(part) ? watched : cite, `${key}-${i}`, links, leaf);
    if (drawn) footnotes.add(i);
    if (typeof node !== 'string') return node;
    return node === '' ? '' : leaf(node, `${key}-m${i}`);
  });
  return holdFootnotes(nodes, footnotes, key).filter((part) => part !== '' && part !== false);
};

const noCitation: CiteRenderer = () => undefined;

// `[1, 2]` is drawn as one element, which no leaf sees: as `[1] [2]` each stays as written.
const citeGroup = /\[(\d+(?:\s*,\s*\d+)+)\]/g;

/**
 * A line's words as this renderer draws them, with none of its inline syntax: emphasis and code
 * as their words, a link as its words and an autolink as its address, `<br>` as a space. Each
 * `[n]` stays as written, for the caller to number or drop.
 */
export const inlineText = (line: string) => {
  let words = '';
  const split = line.replace(/<br\s*\/?>/gi, ' ').replace(citeGroup, (_, list: string) =>
    list
      .split(',')
      .map((n) => `[${n.trim()}]`)
      .join(' '),
  );
  inline(split, noCitation, 'p', false, (value) => {
    words += value;
    return value;
  });
  return words;
};

/** What a table's scroll box is named by: its place among the text's tables, and its columns. */
export interface TableFacts {
  number: number;
  count: number;
  columns: string[];
}

/** Optional ways to draw a text that is an answer rather than a quotation. */
export interface BlockOptions {
  /** Draws `#` as a heading at this level, and deeper ones below it, instead of a bold line. */
  headingLevel?: number | undefined;
  /** Puts each table in a scroll box of its own that a keyboard can reach, named by this. */
  tableName?: ((table: TableFacts) => string) | undefined;
}

// The size follows the depth, not the level: `###` in an answer is a small heading wherever the
// answer sits.
const headingSizes = ['md', 'sm', 'xs', '2xs', '2xs', '2xs'] as const;

const wordsOf = (cell: string) => inlineText(cell).trim();

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
  options: BlockOptions = {},
): ReactNode[] => {
  const blocks = blocksOf(text);
  const tables = blocks.filter((block) => block.kind === 'table');
  return blocks.map((block, i) => {
    const k = `b${i}`;
    if (i > 0) gap?.();
    if (block.kind === 'heading' && options.headingLevel !== undefined)
      return (
        <Heading
          key={k}
          level={Math.min(options.headingLevel + block.depth - 1, 6) as 1 | 2 | 3 | 4 | 5 | 6}
          data-size={headingSizes[block.depth - 1] ?? '2xs'}
          className="uib-markdown-heading"
        >
          {inline(block.text, cite, k, links, leaf)}
        </Heading>
      );
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
    if (block.kind === 'table') {
      const table = (
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
      if (!options.tableName) return table;
      const name = options.tableName({
        number: tables.indexOf(block) + 1,
        count: tables.length,
        columns: block.head.map(wordsOf).filter(Boolean),
      });
      return (
        // A scroll box is reached by keyboard only when it can be focused (Safari, WCAG 2.1.1), and
        // it is a named group rather than a region, so many tables are not many landmarks.
        <div
          key={k}
          className="uib-markdown-table-scroll ds-focus"
          role="group"
          aria-label={name}
          tabIndex={0}
        >
          {table}
        </div>
      );
    }
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
};

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
  headingLevel,
  tableName,
}: {
  text: string;
  cite?: CiteRenderer;
  className?: string;
  /** Whether a link is drawn as one; in a quotation it is text, whatever its syntax. */
  links?: boolean;
  /** Search hits to wrap in `<mark>`; without it the text is drawn as it always was. */
  highlight?: MarkdownHighlight | undefined;
} & BlockOptions) => {
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

  return (
    <div className={className}>
      {renderBlocks(text, cite, links, leaf, undefined, { headingLevel, tableName })}
    </div>
  );
};
