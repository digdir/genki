// Marker's leftovers and Markdown's syntax, which no reader should meet in drawn text.

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

/** HTML and MathML element names, so `<span id=…>` counts and «<navn på virksomhet>» does not. */
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

/** The document's own footnote stars, «** Antall …» or «årsverk**»: its words, not a leftover. */
function isFootnoteStars(match: string, line: string, column: number): boolean {
  if (!/^\*{1,3}$/u.test(match)) return false;
  const before = line.slice(0, column);
  const after = line.slice(column + match.length);
  if (before.trim() === '') return /^[ \t]/u.test(after);
  return /[\p{L}\p{N})]$/u.test(before) && /^(?:\s|$|[.,;:)])/u.test(after);
}

/** A cell's value or a page number: digits, and the signs an amount or a date has. */
const NUMBER_ONLY = /^[\d\s.,:%+\-−–()]+$/u;

/** A web page's title in prose, «ISO 27001 | Digdir»: one «word | word», no number on a side. */
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

/** A page's running head as text, «Årsrapport 2024 | 4»: pages within two, as `isRunningHead`. */
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
    // A thematic break of three or more, or a run of five or more of one character anywhere.
    pattern: /^[ \t]*([-*_=])(?:[ \t]*\1){2,}[ \t]*$|([-*_=])\2{4,}|[–—―─]{3,}/gmu,
    // On a table line it is the table's leftover, counted there.
    isLeftover: (_match, line) => !line.includes('|'),
  },
  {
    name: 'table-pipe',
    what: 'a table row as text: a line with a «|», one hit per line, but a web page title in prose',
    // Cells are joined by « · », so no «|» is left but in a web page's title (`isTitleSeparator`).
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
    // «5 * 3» and `snake_case` keep theirs, and so do footnote stars (`isFootnoteStars`).
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
    // After two lowercase letters at a cell's end and not closing a `(`, so «CO2)» is prose.
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
