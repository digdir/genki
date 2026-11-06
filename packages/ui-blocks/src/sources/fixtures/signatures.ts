/**
 * Leftovers from a source format in text a reader sees: one shared list.
 *
 * A block's tests scan what it draws for what the source format left behind.
 * Kudos chunks are Marker's Markdown from PDFs, so the list is Marker's
 * leftovers and Markdown's syntax: what no reader should meet in an excerpt.
 * Framework-free, so a browser test or a script can read it too.
 *
 * Built for rendered, visible text (`innerText`). It also runs on raw chunk
 * text, for a census, where most signatures are expected to hit. A line can
 * hit more than one signature; each signature counts its own.
 */

export type SignatureName =
  | 'page-marker'
  | 'rule-line'
  | 'table-pipe'
  | 'running-head'
  | 'table-delimiter'
  | 'html-tag'
  | 'html-entity'
  | 'md-emphasis'
  | 'md-link'
  | 'md-image'
  | 'md-heading'
  | 'md-code'
  | 'escape'
  | 'glued-footnote';

export type Signature = {
  readonly name: SignatureName;
  /** What a reader would see, in one line, for reports. */
  readonly what: string;
  /** Global, so every occurrence counts. */
  readonly pattern: RegExp;
  /** False for a match that is not a leftover where it stands. */
  readonly isLeftover?: (match: string, line: string, column: number) => boolean;
};

export type Hit = {
  readonly signature: SignatureName;
  /** The characters that matched. */
  readonly match: string;
  /** 1-based line in the scanned text. */
  readonly line: number;
  /** The line around the match, whitespace collapsed, for a failure message. */
  readonly context: string;
};

export type Scan = Readonly<Record<SignatureName, readonly Hit[]>>;

/** `|:---|---:|`, with or without the outer pipes, and nothing else on the line. */
const DELIMITER_ROW = /^(?=[^\n]*\|)(?=[^\n]*-)[ \t|:-]+$/u;

/**
 * Element names an HTML or MathML document uses, so `<span id=…>` counts and
 * a placeholder like «<navn på virksomhet>» does not. A custom element (a name
 * with a hyphen) counts too.
 */
const ELEMENTS = `
  a abbr address article aside audio b big blockquote body br button caption center cite
  code col colgroup dd del details dfn div dl dt em embed figcaption figure font footer
  form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input ins kbd label li link
  main mark math meta mfrac mi mn mo mrow msub msubsup msup nav object ol option p
  picture pre q s samp script section select small source span strike strong style sub
  summary sup svg table tbody td template textarea tfoot th thead title tr tt u ul var
  video wbr
`
  .trim()
  .split(/\s+/u)
  .join('|');

/** The `(`s still open before `column` on this line, as the cleaner reads a cell. */
function insideParentheses(line: string, column: number): boolean {
  let depth = 0;
  for (const char of line.slice(0, column)) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

/**
 * The document's own footnote mark in stars, one to three: before a space at
 * the start of a line, that is the note («** Antall ansatte og antall avtalte
 * årsverk …», chunk a2bbe7b471a5, `<sup>\*\*</sup>` in the raw text); right
 * after a word or a number, the reference to it («årsverk**»). Allowed, not a
 * leftover: they are the document's words, Unicode has no raised star, and
 * the reference view draws them flat. A part may keep them in a `sup`
 * element instead; it may not drop them. Any other lone `**` still counts.
 */
function isFootnoteStars(match: string, line: string, column: number): boolean {
  if (!/^\*{1,3}$/u.test(match)) return false;
  const before = line.slice(0, column);
  const after = line.slice(column + match.length);
  if (before.trim() === '') return /^[ \t]/u.test(after);
  return /[\p{L}\p{N})]$/u.test(before) && /^(?:\s|$|[.,;:)])/u.test(after);
}

/** A cell's value or a page number: digits, and the signs an amount or a date has. */
const NUMBER_ONLY = /^[\d\s.,:%+\-−–()]+$/u;

/**
 * A web page's title kept as a link's words, the document's own: «… nettsiden
 * Sertifisering etter ISO 27001 | Digdir hvor …» (with «[27001 |
 * Digdir](https://www.digdir.no/…)» in the raw text). Allowed, not a leftover,
 * like the footnote stars: the reference view draws the same words. Only as «word | word» in a line with no
 * other «|», one space on each side.
 *
 * Still a leftover:
 * - a row: two pipes, an outer pipe, or a pipe with no space or with padding;
 * - a label and its value, where one side is only a number or an amount
 *   («Husleie | 3 024 010», «Dato | 31.12.2024»);
 * - a page's running head: a side that is only the page number («4 |
 *   Årsrapport 2024»), as above, or one of 80 characters or less after the pipe
 *   that ends in it («Årsrapport 2024 | side 4»). It counts as `running-head`
 *   (see `isRunningHead`), not as a row.
 */
function isTitleSeparator(line: string): boolean {
  const sides = line.split('|');
  if (sides.length !== 2) return false;
  const before = sides[0] ?? '';
  const after = sides[1] ?? '';
  if (!/[\p{L}\p{N}] $/u.test(before) || !/^ [\p{L}\p{N}]/u.test(after)) return false;
  const left = before.trim();
  const right = after.trim();
  if (NUMBER_ONLY.test(left) || NUMBER_ONLY.test(right)) return false;
  if (right.length <= 80 && /(?<![\d.,])\d{1,3}$/u.test(right)) return false;
  return true;
}

/** A page number: no leading zero, at most three digits. */
const PAGE = /^[1-9]\d{0,2}$/u;
/** A page number glued to a running title, «Lånekassen 46» or «46 Lånekassen». A year is four digits. */
const GLUED_PAGE = /^([1-9]\d{0,2})\s|\s([1-9]\d{0,2})$/u;
const EMPHASIS = /^(\*\*|__|\*|_)([\s\S]*)\1$/u;

/** A cell without the emphasis Marker sets some page numbers in, «**42**». */
function unemphasised(cell: string): string {
  const trimmed = cell.trim();
  const marked = EMPHASIS.exec(trimmed);
  return marked ? (marked[2] ?? '').trim() : trimmed;
}

/**
 * A page's running head or foot left as a line of text: «Årsrapport 2024 |
 * 4», or two pages' run onto one line where a chunk crossed a page break,
 * «**42** | Nkom årsrapport 2020 Nkom årsrapport 2020 | **43 42** | Nkom
 * årsrapport 2020» (Nkom's 2020 report).
 *
 * The shape from `isRunningHead` in excerptMarkdown.ts: every part is a page number or one short piece of
 * text, with at least one of each. A table row's outer pipes leave an empty
 * part, so it is never one. Tighter on numbers, measured on that function: a part of digits
 * that is not a page number is an amount and makes the line a row
 * («Husleie | 3 024 010 | 2 900 000», «Driftsutgifter | 232 100»), and the
 * page numbers on one line lie within two of each other, as a spread's do,
 * so «Årsverk | 158 | 162» is a row too. A running head without a pipe looks
 * like prose that ends in a number, and is not looked for.
 */
function isRunningHead(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed.split('|').map(unemphasised);
  if (cells.length > 6) return false;
  const pages: number[] = [];
  let words = 0;
  for (const cell of cells) {
    const numbers = cell.split(' ');
    if (numbers.length <= 2 && numbers.every((number) => PAGE.test(number))) {
      pages.push(...numbers.map(Number));
    } else if (/\p{L}/u.test(cell) && cell.length <= 80) {
      words += 1;
      const glued = GLUED_PAGE.exec(cell);
      if (glued !== null) pages.push(Number(glued[1] ?? glued[2]));
    } else {
      return false;
    }
  }
  return pages.length > 0 && words > 0 && Math.max(...pages) - Math.min(...pages) <= 2;
}

export const SIGNATURES: readonly Signature[] = [
  {
    name: 'page-marker',
    what: "Marker's page marker, a page number in braces: «{9}»",
    pattern: /(?<![\p{L}\p{N}$])\{\d{1,4}\}(?![\p{L}\p{N}])/gu,
  },
  {
    name: 'rule-line',
    what: 'a line of dashes, stars, underscores or equals signs, or a long run of one inside a line',
    // A line of three or more (spaces allowed between, as Markdown reads a
    // thematic break), or a run of five or more of one character anywhere.
    pattern: /^[ \t]*([-*_=])(?:[ \t]*\1){2,}[ \t]*$|([-*_=])\2{4,}|[–—―─]{3,}/gmu,
    // On a table line it is the table's leftover, counted there.
    isLeftover: (_match, line) => !line.includes('|'),
  },
  {
    name: 'table-pipe',
    what: 'a table row as text: a line with a «|», one hit per line, but a web page title in prose',
    // A table in an excerpt is drawn as rows, one per line, its cells joined
    // by « · ». So no «|» is left on screen, not even one between two cells. The
    // one exception is a web page's title in prose (see `isTitleSeparator`).
    pattern: /^[^\n]*\|[^\n]*$/gmu,
    isLeftover: (_match, line) =>
      !DELIMITER_ROW.test(line) && !isTitleSeparator(line) && !isRunningHead(line),
  },
  {
    name: 'running-head',
    what: "a page's running head or foot as text: «Årsrapport 2024 | 4», or two pages' run together",
    // The cleaners drop one only on a line of its own; drawn, it is a line.
    pattern: /^[^\n]*\|[^\n]*$/gmu,
    isLeftover: (_match, line) => isRunningHead(line),
  },
  {
    name: 'table-delimiter',
    what: 'the line under a table header: «|---|:---:|»',
    pattern: /^(?=[^\n]*\|)(?=[^\n]*-)[ \t|:-]+$/gmu,
  },
  {
    name: 'html-tag',
    what: 'an HTML tag or comment: «<span id="page-4-0">», «<sup>», «<!--»',
    pattern: new RegExp(
      `</?(?:${ELEMENTS}|[a-z][a-z0-9]*-[a-z0-9-]*)(?:[\\s/][^<>]*)?>|<!--`,
      'giu',
    ),
  },
  {
    name: 'html-entity',
    what: 'an HTML entity: «&amp;», «&#160;», «&nbsp;»',
    pattern: /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/giu,
  },
  {
    name: 'md-emphasis',
    what: 'Markdown emphasis: «**bold**», «*italic*», «__bold__», «_italic_», «~~struck~~», or a lone «**»',
    // `*` counts only with no space just inside it, so «5 * 3» keeps its
    // star; `_` only at a word's edge, so `snake_case` keeps its. A lone
    // run of stars that is the document's own footnote mark is not counted
    // (see `isFootnoteStars`).
    pattern: new RegExp(
      [
        String.raw`\*\*(?=\S)[^\n]*?\S\*\*`,
        String.raw`(?<![\p{L}\p{N}_])__(?=\S)[^\n]*?\S__(?![\p{L}\p{N}_])`,
        String.raw`~~(?=\S)[^\n]*?\S~~`,
        String.raw`(?<![\p{L}\p{N}*\\])\*(?=[^\s*])[^*\n]*?[^\s*\\]\*(?![\p{L}\p{N}*])`,
        String.raw`(?<![\p{L}\p{N}_\\])_(?=[^\s_])[^_\n]*?[^\s_\\]_(?![\p{L}\p{N}_])`,
        String.raw`\*{2,}|~~`,
      ].join('|'),
      'gu',
    ),
    isLeftover: (match, line, column) => !isFootnoteStars(match, line, column),
  },
  {
    name: 'md-link',
    what: 'Markdown link syntax: «[text](address)», «[text][ref]», «<https://…>»',
    pattern: /(?<!!)\[[^\]\n]+\]\([^)\n]*\)|(?<!!)\[[^\]\n]+\]\[[^\]\n]*\]|<https?:\/\/[^>\s]+>/gu,
  },
  {
    name: 'md-image',
    what: 'Markdown image syntax: «![](_page_3_Picture_1.jpeg)»',
    pattern: /!\[[^\]\n]*\]\([^)\n]*\)/gu,
  },
  {
    name: 'md-heading',
    what: 'a Markdown heading marker at the start of a line: «## 2.1 Mål»',
    pattern: /^[ \t]{0,3}#{1,6}[ \t]+\S/gmu,
  },
  {
    name: 'md-code',
    what: 'Markdown code: «`text`» or a fence «```»',
    pattern: /`{3,}|`[^`\n]+`/gu,
  },
  {
    name: 'escape',
    what: 'a backslash escape: «\\*», «\\_», «\\|»',
    pattern: /\\[\\`*_{}[\]()#+\-.!|"'~<>]/gu,
  },
  {
    name: 'glued-footnote',
    what: 'a footnote mark glued to a word at the end of a cell: «Husleie1)»',
    // The mark Marker leaves in a table cell, where it lost its raise. In
    // prose the shape can mean something else («Q4)», «CO2)»), so it counts
    // only after two lowercase letters, before the end of a cell or line,
    // and not where it closes a `(` (the cleaner draws the same line).
    pattern: /(?<=\p{Ll}{2})\d{1,2}\)(?=[ \t]*(?:$|\t|·|\|))/gmu,
    isLeftover: (_match, line, column) => !insideParentheses(line, column),
  },
];

export const SIGNATURE_NAMES: readonly SignatureName[] = SIGNATURES.map(
  (signature) => signature.name,
);

const flat = (text: string) => text.replace(/\s+/gu, ' ').trim();

function lineAt(text: string, index: number): { number: number; start: number; text: string } {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return {
    number: text.slice(0, start).split('\n').length,
    start,
    text: text.slice(start, end === -1 ? undefined : end),
  };
}

/** Every leftover in `text`, per signature. Every signature has a list, empty or not. */
export function scan(text: string): Scan {
  const normalised = text.replace(/\r\n?/gu, '\n');
  const result = Object.fromEntries(SIGNATURE_NAMES.map((name) => [name, [] as Hit[]])) as Record<
    SignatureName,
    Hit[]
  >;
  for (const signature of SIGNATURES) {
    for (const found of normalised.matchAll(signature.pattern)) {
      const index = found.index;
      const line = lineAt(normalised, index);
      if (signature.isLeftover?.(found[0], line.text, index - line.start) === false) continue;
      result[signature.name].push({
        signature: signature.name,
        match: found[0],
        line: line.number,
        context: flat(line.text).slice(0, 160),
      });
    }
  }
  return result;
}

/** How many hits each signature has, in the list's order. */
export function counts(result: Scan): Record<SignatureName, number> {
  return Object.fromEntries(SIGNATURE_NAMES.map((name) => [name, result[name].length])) as Record<
    SignatureName,
    number
  >;
}

/** Every hit, in the list's order and then by line. */
export function hits(result: Scan): Hit[] {
  return SIGNATURE_NAMES.flatMap((name) => result[name]);
}

/** One line per hit, for a failure message or a report. */
export function describeHits(result: Scan, limit = 20): string {
  const all = hits(result);
  const lines = all
    .slice(0, limit)
    .map((hit) => `${hit.signature} «${flat(hit.match)}» on line ${hit.line}: ${hit.context}`);
  if (all.length > limit) lines.push(`… and ${all.length - limit} more`);
  return lines.join('\n');
}
