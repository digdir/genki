import { decodeEntities } from '../markdown/Markdown.js';

// Excerpts are Marker's Markdown from PDF conversion. This keeps what is Markdown for
// Markdown to draw, drops what the conversion left (page markers, page rules,
// running heads, anchors and other tags), and writes headings, list items, table rows,
// links and raised marks as text, as KA's readableText does.
// Not a sanitiser; Markdown draws everything as text.

// Backslash escapes become noncharacters (U+FDD0 on) until the end, so an escaped
// `|` or `<` is never cut or taken for a tag. Not private use: Kudos has some in its text.
const ESCAPABLE = '\\`*_{}[]()#+-.!|"\'~<>';
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!|"'~<>])/g;
const BASE = 0xfdd0;
const NONCHARACTER = /[\ufdd0-\ufdef]/g;

// The one tag Markdown draws in an excerpt, kept as a noncharacter while every other goes.
const BREAK = '\ufdec';
const KEPT: Record<string, string> = { [BREAK]: '<br>' };

const escaped = (char: string) => String.fromCharCode(BASE + ESCAPABLE.indexOf(char));

const protect = (text: string) =>
  text
    .replace(NONCHARACTER, '')
    .replace(ESCAPED, (_, char: string) => String.fromCharCode(BASE + ESCAPABLE.indexOf(char)));

const restore = (text: string) =>
  text.replace(
    NONCHARACTER,
    (char) => KEPT[char] ?? `\\${ESCAPABLE[char.charCodeAt(0) - BASE] ?? ''}`,
  );

const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
// `<` or `</` and a letter; the name ends at a space or `/`, as HTML reads it.
const TAG = /<\/?[a-z][a-z0-9-]*(?:[\s/][^<>]*)?>/gi;
const BREAK_TAG = /<br\s*\/?>/gi;
const RAISABLE = /<(sup|sub)\b[^<>]*>([\s\S]*?)<\/\1\s*>/gi;
const IMAGE = /!\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g;
// A link in a quotation is its words, as KA draws it; the document link is at the card's end.
const LINK = /\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))*\)/g;
const AUTOLINK = /<(https?:\/\/[^<>\s]+)>/gi;

// Repeated until nothing changes, since one round of `<scr<script>ipt>` leaves `<script>`.
const removeUntilStable = (text: string, ...patterns: RegExp[]) => {
  let result = text;
  let previous: string;
  do {
    previous = result;
    for (const pattern of patterns) result = result.replace(pattern, '');
  } while (result !== previous);
  return result;
};

const RAISED: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '−': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
};

const LOWERED: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '−': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
};

const shifted = (text: string, characters: Record<string, string>) => {
  const chars = [...text];
  return chars.every((char) => char in characters)
    ? chars.map((char) => characters[char]).join('')
    : undefined;
};
const raised = (text: string) => shifted(text, RAISED);
const shiftedBy = (tag: string) => (tag.toLowerCase() === 'sup' ? RAISED : LOWERED);

// «Husleie1)» in a table cell is a footnote mark that lost its raise; in prose the
// shape can mean something else. A `)` that closes an open `(` is kept.
const GLUED_FOOTNOTE = /(?<=\p{L})\d{1,2}\)(?![\p{L}\p{N}])/gu;

const insideParentheses = (text: string, offset: number) => {
  let depth = 0;
  for (const char of text.slice(0, offset)) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
  }
  return depth > 0;
};

const raiseGluedFootnotes = (text: string) =>
  text.replace(GLUED_FOOTNOTE, (mark: string, offset: number) =>
    insideParentheses(text, offset) ? mark : (raised(mark) ?? mark),
  );

// What Markdown would read as markup in a raised mark's text, «*» above all.
const MARKUP = /[\\`*_~[\]|]/g;

// A `<sup>` or `<sub>` as superscript or subscript characters when every character has one,
// «m²», «CO₂», else as its text, a footnote's «*» included: KA's readableText rule for
// `<sup>`, used for `<sub>` too. No element is left, and the tag's attributes and inner tags go.
const shiftMark = (_: string, name: string, inner: string) => {
  const text = removeUntilStable(inner, SCRIPT_OR_STYLE, COMMENT, TAG);
  return shifted(text.trim(), shiftedBy(name)) ?? text.replace(MARKUP, escaped);
};

const inline = (text: string, cell: boolean) => {
  const kept = removeUntilStable(text, SCRIPT_OR_STYLE, COMMENT)
    .replace(RAISABLE, shiftMark)
    .replace(BREAK_TAG, cell ? ' ' : BREAK);
  const clean = removeUntilStable(kept, SCRIPT_OR_STYLE, COMMENT, TAG)
    .replace(IMAGE, '$1')
    .replace(LINK, '$1')
    .replace(AUTOLINK, '$1');
  return (cell ? raiseGluedFootnotes(clean) : clean).replace(/[ \t]+/g, ' ').trim();
};

// Marker's page marker, the page number alone on its line, and its rule.
const PAGE_MARKER = /^\{\d+\}$/;
const THEMATIC_BREAK = /^(?:([-*_])(?:\s*\1){2,}|={3,})$/;
const TABLE_ROW = /^\|.*\|$/;
const DELIMITER_CELL = /^\s*:?-+:?\s*$/;
const FENCE = /^\s*```/;
// A page's running head or foot, «Årsrapport 2024 | 4». Marker sets the page number in bold in
// some reports, and where a chunk crosses a page break it can run two pages' heads onto one line
// with the title repeated and the numbers together: «**42** | Nkom årsrapport 2020 Nkom årsrapport
// 2020 | **43 42** | Nkom årsrapport 2020» (Nkom's 2020 report). One pipe
// and a number at one end does not cover that, so the rule is about the shape of the whole line:
// every part is either a page number or one short piece of text, with at least one of each.
// A table row is not one — it starts and ends with a pipe. Only on a line of its own, since prose
// can hold the same shape.
const PAGE_NUMBERS = /^\d{1,3}(?: \d{1,3}){0,3}$/;
const HEAD_TEXT = /^[^|]{1,80}$/;
// The number can be glued to the title instead of standing alone, «Årsrapport 2022 | Lånekassen
// 46». A year is four digits, so it is not one of these.
const GLUED_NUMBER = /(?:^\d{1,3}\s)|(?:\s\d{1,3}$)/;
const EMPHASIS = /^(\*\*|__|\*|_)([\s\S]*)\1$/;

// «**42**» is the page number Marker emphasised, not a word.
const unemphasised = (cell: string) => {
  const trimmed = cell.trim();
  const marked = EMPHASIS.exec(trimmed);
  return marked ? (marked[2] ?? '').trim() : trimmed;
};

// Two pages of one report are a page apart, never a hundred. A line of numbers that are far
// apart is a row of figures with its outer pipes lost — «Husleie | 3 024 010 | 2 900 000»,
// «Årsverk | 158 | 162» — and deleting one of those from a quotation is worse than leaving a
// running head in, because nobody can see that it went.
const PAGE_SPREAD = 2;

const isRunningHead = (line: string) => {
  if (!line.includes('|') || line.startsWith('|') || line.endsWith('|')) return false;
  const cells = line.split('|').map(unemphasised);
  if (cells.length > 6) return false;
  const numbers: number[] = [];
  let words = 0;
  for (const cell of cells) {
    if (PAGE_NUMBERS.test(cell)) numbers.push(...cell.split(' ').map(Number));
    else if (cell !== '' && HEAD_TEXT.test(cell)) {
      words += 1;
      const glued = GLUED_NUMBER.exec(cell);
      if (glued) numbers.push(Number(glued[0]));
    } else return false;
  }
  if (numbers.length === 0 || words === 0) return false;
  return Math.max(...numbers) - Math.min(...numbers) <= PAGE_SPREAD;
};
// Marker escaping a tag and raising the escape's «&» with it: «<sup>&</sup>lt;sup>5</sup>».
const SPLIT_ENTITY = /<sup>&<\/sup>(lt|gt);/gi;
const HEADING = /^#{1,6}\s+(.*?)(?:\s+#+)?$/;

// A line that must read as text, not as a list item or a heading.
const literal = (line: string) =>
  line
    .replace(/^(\d{1,9})([.)])(?=\s)/, (_, n: string, mark: string) => n + escaped(mark))
    .replace(/^([-*+#>])(?=\s|$)/, (_, mark: string) => escaped(mark));

const cellsOf = (row: string) => row.replace(/^\|/, '').replace(/\|$/, '').split('|');

// A table row as one line, cells joined by « · », since an excerpt is a quotation in a
// narrow column. Empty rows and trailing cells go; an empty cell before a filled one is
// «–», so the columns keep their place.
const tableRow = (row: string) => {
  const cells = cellsOf(row);
  if (cells.every((cell) => DELIMITER_CELL.test(cell))) return undefined;
  const text = cells.map((cell) => inline(cell, true));
  while (text.length > 0 && text.at(-1) === '') text.pop();
  return text.length ? literal(text.map((cell) => cell || '–').join(' · ')) : undefined;
};

export const excerptMarkdown = (markdown: string): string => {
  const lines = removeUntilStable(
    protect(markdown.replace(/\r\n?/g, '\n')).replace(SPLIT_ENTITY, (_, name: string) =>
      name.toLowerCase() === 'lt' ? '<' : '>',
    ),
    SCRIPT_OR_STYLE,
    COMMENT,
  ).split('\n');
  const alone = (i: number) => !lines[i - 1]?.trim() && !lines[i + 1]?.trim();
  const out: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (FENCE.test(raw)) fenced = !fenced;
    if (fenced || FENCE.test(raw)) {
      out.push(raw);
      continue;
    }
    const line = raw.trim();
    if (PAGE_MARKER.test(line) || THEMATIC_BREAK.test(line)) continue;
    if (isRunningHead(line) && alone(i)) continue;
    // A row the chunk cut off still counts when the row above it is whole.
    if (
      TABLE_ROW.test(line) ||
      (line.startsWith('|') && TABLE_ROW.test(lines[i - 1]?.trim() ?? ''))
    ) {
      const row = tableRow(line);
      if (row) out.push(row);
      continue;
    }
    // A list item is a line with a bullet and a heading a line of its own, as KA draws them.
    const block = line.replace(/^>\s?/, '').replace(/^[-*+]\s+/, '• ');
    const title = HEADING.exec(block);
    const text = inline(title?.[1] ?? block, false);
    if (text || !line) out.push(literal(text));
  }
  return restore(
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
};

// Back to the characters, for text that is drawn as text and never read as Markdown.
const restorePlain = (text: string) =>
  text.replace(NONCHARACTER, (char) =>
    char in KEPT ? '' : (ESCAPABLE[char.charCodeAt(0) - BASE] ?? ''),
  );

// KA's readableHeading: one step of a heading path as plain text, with its tags, anchors,
// emphasis, links and code gone, and its marks raised. `_` counts only at a word's edge,
// and `*` only with no space just inside it.
const plain = (step: string) =>
  decodeEntities(
    restorePlain(
      removeUntilStable(
        removeUntilStable(protect(step), SCRIPT_OR_STYLE, COMMENT)
          .replace(RAISABLE, (_, name: string, inner: string) => {
            const text = removeUntilStable(inner, TAG).trim();
            return shifted(text, shiftedBy(name)) || text;
          })
          .replace(BREAK_TAG, ' '),
        SCRIPT_OR_STYLE,
        COMMENT,
        TAG,
      )
        .replace(IMAGE, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
        .replace(/(?<![\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, '$1')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
        .replace(/(?<![\p{L}\p{N}*])\*(?=\S)([^*\n]*?\S)\*(?![\p{L}\p{N}*])/gu, '$1')
        .replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, '$1'),
    ),
  )
    .replace(/\s+/g, ' ')
    .trim();

const STEP = ' › ';

/** A heading path as one line of text; a step that was only an anchor goes with its separator. */
export const headingText = (heading: string | undefined): string | undefined => {
  if (heading === undefined) return undefined;
  return heading.split(STEP).map(plain).filter(Boolean).join(STEP) || undefined;
};
