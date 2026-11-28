/**
 * Heading levels from a PDF, for `docling-parts` 2 (ADR 0055, issue 516): Docling gives every heading
 * level 1, so a heading's level comes, in this order, from the PDF's outline, from its section number,
 * or from its text size. Ported from `benchmarks/ingestion/blocks/heading_levels.py`.
 */
import type { PartBox } from '@genai/port-knowledge';
import { numberDepth } from './docling-walk.js';

/** An entry of a PDF's outline: its title, its depth from 1, and its page from 1, null when it has none. */
export interface OutlineEntry {
  title: string;
  level: number;
  page: number | null;
}

/** A run of the PDF's text layer: its page from 1, its box as fractions of the page from the top left. */
export interface PdfTextRun {
  page: number;
  box: PartBox;
  /** Font size times the text matrix's scale, in points. */
  size: number;
  bold: boolean;
  /** Characters that are not white space. */
  chars: number;
}

/** What the levels read from a PDF: only its outline and its text sizes, never its text. */
export interface PdfLayout {
  outline: OutlineEntry[];
  runs: PdfTextRun[];
}

/** A heading to level: its text, its first page and box there, and that page's height in points. */
export interface LevelledHeading {
  text: string;
  page: number | undefined;
  box: PartBox | undefined;
  pageHeight: number | undefined;
}

export type LevelSource = 'outline' | 'number' | 'below-outline' | 'size-font' | 'size-box';

export interface HeadingLevelsOptions {
  /** Off only to score the other rungs against the outline. */
  outline?: boolean;
}

/** At least this share of the headings to level must carry a section number to level them by it. */
const minNumberedShare = 0.3;
/** At most this many levels by size in a document without section numbers. */
const maxSizeLevels = 4;
/** Bold counts as this many points more, so equal sizes split by weight but never pass a size 0.5 pt bigger. */
const boldBonus = 0.4;
/** Fewer characters than this in a heading's box: its size is its box height. */
const minChars = 3;
/** Smaller than the deepest numbered level by more than this, in points: one level below it. */
const smallerGap = 0.5;

/** A leading section number, as `numberDepth` in the walk reads it. */
const sectionNumber = /^[\s#*]*(\d+(?:\.\d+)*)\.?\s+\S/;
/** A section number with a space before or after its dots, as some PDFs set it: «3 .1. 1», «4 . 4 . 2». */
const spacedNumber = /^[\s#*]*(\d{1,3}(?: ?\. ?\d{1,3}){1,5})(?![\d.])/;
/** A chapter or part word and the token after it: «Kapittel 3», «Del II», «CHAPTER THREE:». */
const chapterWord = /^[\s#*]*(kapittel|kap\.|chapter|del|part)[ \t]+([\p{L}\p{N}]+)/iu;
const romanNumeral = /^[IVXLC]{1,7}$/;
/** What follows a budget chapter's number: «post 21». */
const budgetPost = /^\s+post(?![\p{L}\p{N}])/iu;
const numberWords = new Set(
  (
    'en ett to tre fire fem seks sju syv åtte ni ti elleve tolv første andre tredje fjerde femte sjette ' +
    'one two three four five six seven eight nine ten eleven twelve first second third fourth fifth sixth'
  ).split(' '),
);

/** «part» for «Del»/«Part», «chapter» for «Kapittel»/«Chapter», with a number, numeral or number word. */
const chapterKind = (text: string): 'part' | 'chapter' | undefined => {
  const normalized = text.normalize('NFKC');
  const match = chapterWord.exec(normalized);
  const [word, token] = [match?.[1]?.toLowerCase(), match?.[2] ?? ''];
  if (!word || !match) return undefined;
  // «Kap. 275 post 21» is a line of the state budget, as allocation letters head them, not a chapter.
  if (budgetPost.test(normalized.slice(match.index + match[0].length))) return undefined;
  const counted =
    /^\d{1,3}$/.test(token) || romanNumeral.test(token) || numberWords.has(token.toLowerCase());
  if (!counted) return undefined;
  return word === 'del' || word === 'part' ? 'part' : 'chapter';
};

/**
 * A heading's depth from its section number, for `docling-parts` 2 only: as the walk's `numberDepth`,
 * except that trailing zero parts do not count («2.0» is a chapter, depth 1) and a number with spaced
 * dots counts all its parts («3 . 2 . 1» is depth 3).
 */
const sectionDepth = (text: string) => {
  const depth = numberDepth(text);
  if (depth === undefined) return undefined;
  const normalized = text.normalize('NFKC');
  const spaced = spacedNumber.exec(normalized)?.[1];
  const parts = (spaced ?? sectionNumber.exec(normalized)?.[1] ?? '').replace(/ /g, '').split('.');
  while (parts.length > 1 && /^0+$/.test(parts.at(-1) ?? '')) parts.pop();
  return spaced ? parts.length : Math.min(depth, parts.length);
};

const leadingNumber = /^[\s#*]*(?:\d+(?:\.\d+)*\.?|[ivx]+\.|[a-z]\))\s+/;
const punctuation = /[^\p{L}\p{N}_ ]+/gu;

/** A title for matching: NFKC, lower case, no leading number, letters, digits and single spaces. */
const norm = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(leadingNumber, '')
    .replace(punctuation, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The share of characters two strings have in common, as Python's `difflib` ratio counts it. */
const ratio = (a: string, b: string) => {
  // The longest common subsequence stands in for difflib's matching blocks: equal on short titles.
  const x = [...a];
  const y = [...b];
  let previous = new Array<number>(y.length + 1).fill(0);
  for (const cx of x) {
    const row = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j += 1)
      row[j] =
        cx === y[j - 1] ? (previous[j - 1] ?? 0) + 1 : Math.max(previous[j] ?? 0, row[j - 1] ?? 0);
    previous = row;
  }
  return (2 * (previous[y.length] ?? 0)) / (x.length + y.length);
};

/** Titles too long to compare are cut, so the comparison stays small. */
const maxTitle = 200;
/** At most this many heading and outline pairs are looked at, so a PDF cannot make the match slow. */
const maxPairs = 20_000;
/** At most this many pairs get the full comparison, about 0.1 ms each on two long titles. */
const maxRatios = 2_000;

/** A title cut for matching, with how many times each of its characters comes. */
const titleOf = (text: string) => {
  const title = [...norm(text)].slice(0, maxTitle).join('');
  const counts = new Map<string, number>();
  for (const c of title) counts.set(c, (counts.get(c) ?? 0) + 1);
  return { title, counts, length: [...title].length };
};

/**
 * The most two titles can share by their character counts, as difflib's `quick_ratio`: a pair below
 * the bar never needs the full comparison.
 */
const quickRatio = (a: ReturnType<typeof titleOf>, b: ReturnType<typeof titleOf>) => {
  let shared = 0;
  for (const [c, n] of a.counts) shared += Math.min(n, b.counts.get(c) ?? 0);
  return (2 * shared) / (a.length + b.length || 1);
};

/**
 * Each outline entry with a page, matched to the first heading not yet matched on its page or next to
 * it. The work is capped: at most `maxPairs` headings are looked at, matched ones too, and at most
 * `maxRatios` pairs get the full comparison. An entry looked at after the first cap matches nothing;
 * after the second, only a title that holds the other still matches. Headings left unmatched are
 * levelled by the other rungs.
 */
const outlineMatches = (headings: readonly LevelledHeading[], outline: readonly OutlineEntry[]) => {
  const found = new Map<number, number>();
  const titles = headings.map((h) => titleOf(h.text));
  const onPage = new Map<number, number[]>();
  headings.forEach((h, i) => {
    if (h.page === undefined) return;
    const held = onPage.get(h.page);
    if (held) held.push(i);
    else onPage.set(h.page, [i]);
  });
  let pairs = 0;
  let ratios = 0;
  const same = (title: ReturnType<typeof titleOf>, other: ReturnType<typeof titleOf>) => {
    if (!other.title) return false;
    const { title: a, length: la } = title;
    const { title: b, length: lb } = other;
    if (la >= 6 && lb >= 6 && (a.includes(b) || b.includes(a))) return true;
    if (quickRatio(title, other) < 0.85 || ratios >= maxRatios) return false;
    ratios += 1;
    return ratio(a, b) >= 0.85;
  };
  for (const entry of outline) {
    if (pairs >= maxPairs) break;
    // An entry with no page destination cannot be placed: skipped (issue 516).
    if (entry.page === null) continue;
    const title = titleOf(entry.title);
    if (!title.title) continue;
    // The page before, its own and the one after, in reading order, which is page order. Every
    // heading looked at counts against the cap, matched ones too.
    let at: number | undefined;
    search: for (const page of [entry.page - 1, entry.page, entry.page + 1])
      for (const i of onPage.get(page) ?? []) {
        if (pairs >= maxPairs) break search;
        pairs += 1;
        if (!found.has(i) && same(title, titles[i] as ReturnType<typeof titleOf>)) {
          at = i;
          break search;
        }
      }
    if (at !== undefined) found.set(at, entry.level);
  }
  return found;
};

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

/** The heading's text size from the text layer's runs in its box, or else its box height. */
const sizeOf = (
  heading: LevelledHeading,
  runsOn: ReadonlyMap<number, PdfTextRun[]>,
): { size: number; from: 'font' | 'box' } | undefined => {
  const { box, page, pageHeight } = heading;
  if (!box || page === undefined) return undefined;
  const [x0, y0, x1, y1] = box;
  // A run counts when its middle is inside the box, with a point's slack on each side.
  const slack = pageHeight ? 1 / pageHeight : 0;
  const inside = (runsOn.get(page) ?? []).filter((run) => {
    const cx = (run.box[0] + run.box[2]) / 2;
    const cy = (run.box[1] + run.box[3]) / 2;
    return (
      run.chars > 0 && cx >= x0 - slack && cx <= x1 + slack && cy >= y0 - slack && cy <= y1 + slack
    );
  });
  const chars = inside.reduce((sum, run) => sum + run.chars, 0);
  if (chars >= minChars) {
    // The median over characters, as the prototype reads the layer a character at a time.
    const sizes = inside.flatMap((run) => new Array<number>(run.chars).fill(run.size));
    const bold = inside.reduce((sum, run) => sum + (run.bold ? run.chars : 0), 0) > chars / 2;
    return { size: round1(median(sizes) + (bold ? boldBonus : 0)), from: 'font' };
  }
  if (!pageHeight) return undefined;
  const size = round1((y1 - y0) * pageHeight);
  // A box with no finite height gives no size, so the heading is levelled as one without a size.
  return Number.isFinite(size) ? { size, from: 'box' } : undefined;
};

/**
 * Each heading's level and the rung that set it, in the headings' order. A heading the outline lists
 * takes its level; in a document where enough headings carry a section number, a numbered heading
 * takes its depth, and a chapter or part word with a number («Kapittel 3», «Del II», not the budget
 * line «Kap. 275 post 21») sets its own; a heading with neither after an outline heading goes one
 * level below it; any other heading is levelled by its text size, a chapter or part word at level 1.
 */
export const headingLevels = (
  headings: readonly LevelledHeading[],
  layout: PdfLayout,
  options: HeadingLevelsOptions = {},
): { level: number; source: LevelSource }[] => {
  const result = new Array<{ level: number; source: LevelSource } | undefined>(headings.length);
  const fromOutline =
    options.outline === false
      ? new Map<number, number>()
      : outlineMatches(headings, layout.outline);
  for (const [i, level] of fromOutline) result[i] = { level, source: 'outline' };

  const rest = headings.flatMap((h, i) => (fromOutline.has(i) ? [] : [i]));
  const runsOn = new Map<number, PdfTextRun[]>();
  for (const run of layout.runs) {
    const held = runsOn.get(run.page);
    if (held) held.push(run);
    else runsOn.set(run.page, [run]);
  }
  const sizes = new Map(rest.map((i) => [i, sizeOf(headings[i] as LevelledHeading, runsOn)]));
  const depths = new Map(rest.map((i) => [i, sectionDepth(headings[i]?.text ?? '')]));
  const byNumber =
    rest.length > 0 &&
    rest.filter((i) => depths.get(i) !== undefined).length / rest.length >= minNumberedShare;
  // In a numbered document, «Kapittel 3» is a chapter, depth 1, and «Del II» a part above the
  // chapters: with parts, every other depth goes one down. Chapter words do not count towards the
  // share, so «Del en» alone does not make a document numbered.
  if (byNumber) {
    const kinds = new Map(rest.map((i) => [i, chapterKind(headings[i]?.text ?? '')]));
    const parts = rest.some((i) => depths.get(i) === undefined && kinds.get(i) === 'part');
    for (const i of rest) {
      const depth = depths.get(i);
      const kind = kinds.get(i);
      if (depth !== undefined) depths.set(i, depth + (parts ? 1 : 0));
      else if (kind) depths.set(i, kind === 'part' || !parts ? 1 : 2);
    }
  }
  const numbered = rest.filter((i) => depths.get(i) !== undefined);
  if (byNumber)
    for (const i of numbered) result[i] = { level: depths.get(i) as number, source: 'number' };

  // An unnumbered heading, with no chapter word, one level below the nearest outline heading before
  // it (issue 516, Q1). A numbered one in a document with few numbers is levelled by its size.
  let inForce: number | undefined;
  for (let i = 0; i < headings.length; i += 1) {
    if (fromOutline.has(i)) inForce = fromOutline.get(i);
    else if (
      !result[i] &&
      inForce !== undefined &&
      depths.get(i) === undefined &&
      !chapterKind(headings[i]?.text ?? '')
    )
      result[i] = { level: inForce + 1, source: 'below-outline' };
  }

  const bySize = rest.filter((i) => !result[i]);
  const sourceOf = (i: number): LevelSource =>
    sizes.get(i)?.from === 'box' ? 'size-box' : 'size-font';
  if (byNumber) {
    // The numbered level whose median size is nearest; bigger than every level 1 by over a point is level 1.
    const byLevel = new Map<number, number[]>();
    for (const i of numbered) {
      const size = sizes.get(i)?.size;
      const level = depths.get(i) as number;
      if (size !== undefined) byLevel.set(level, [...(byLevel.get(level) ?? []), size]);
    }
    const medians = [...byLevel].map(([level, values]) => [level, median(values)] as const);
    const first = medians.find(([level]) => level === 1)?.[1];
    const deepest = [...medians].sort((a, b) => b[0] - a[0])[0];
    for (const i of bySize) {
      const size = sizes.get(i)?.size;
      let level = 1;
      if (size !== undefined && medians.length > 0 && !(first !== undefined && size > first + 1))
        level = [...medians].sort(
          (a, b) => Math.abs(a[1] - size) - Math.abs(b[1] - size) || a[0] - b[0],
        )[0]?.[0] as number;
      // Smaller than the deepest numbered level by more than half a point: one level below it.
      if (size !== undefined && deepest && size < deepest[1] - smallerGap) level = deepest[0] + 1;
      result[i] = { level, source: sourceOf(i) };
    }
  } else {
    // Sizes to the half point, ranked from the biggest; a size only one heading has joins the nearest
    // size more have. Ranked over every heading the size rung could level, as the prototype does.
    // «Kapittel 2» or «Del II» is level 1, and the other headings rank from level 2 below them.
    const chapters = new Set(bySize.filter((i) => chapterKind(headings[i]?.text ?? '')));
    const half = new Map(
      rest.flatMap((i) => {
        if (chapters.has(i)) return [];
        const size = sizes.get(i)?.size;
        return size === undefined ? [] : [[i, Math.round(size * 2) / 2] as const];
      }),
    );
    const counts = new Map<number, number>();
    for (const size of half.values()) counts.set(size, (counts.get(size) ?? 0) + 1);
    const common = [...counts].filter(([, n]) => n > 1).map(([size]) => size);
    const pool = common.length > 0 ? common : [...counts.keys()];
    const snap = (size: number) =>
      pool.includes(size)
        ? size
        : ([...pool].sort((a, b) => Math.abs(a - size) - Math.abs(b - size) || b - a)[0] as number);
    const order = [...new Set([...half.values()].map(snap))].sort((a, b) => b - a);
    for (const i of bySize) {
      const size = half.get(i);
      const below = chapters.size > 0 ? 1 : 0;
      const level = chapters.has(i)
        ? 1
        : size === undefined
          ? 1 + below
          : Math.min(order.indexOf(snap(size)) + 1 + below, maxSizeLevels);
      result[i] = { level, source: sourceOf(i) };
    }
  }
  return result.map((r) => r ?? { level: 1, source: 'size-box' });
};
