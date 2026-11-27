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

const similar = (a: string, b: string) => {
  if (!a || !b) return false;
  if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) return true;
  return ratio(a.slice(0, maxTitle), b.slice(0, maxTitle)) >= 0.85;
};

/** Each outline entry with a page, matched to the first heading not yet matched on its page or next to it. */
const outlineMatches = (headings: readonly LevelledHeading[], outline: readonly OutlineEntry[]) => {
  const found = new Map<number, number>();
  const titles = headings.map((h) => norm(h.text));
  for (const entry of outline) {
    // An entry with no page destination cannot be placed: skipped (issue 516).
    if (entry.page === null) continue;
    const title = norm(entry.title);
    if (!title) continue;
    const at = headings.findIndex(
      (h, i) =>
        !found.has(i) &&
        h.page !== undefined &&
        Math.abs(h.page - (entry.page as number)) <= 1 &&
        similar(title, titles[i] ?? ''),
    );
    if (at >= 0) found.set(at, entry.level);
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
  return { size: round1((y1 - y0) * pageHeight), from: 'box' };
};

/**
 * Each heading's level and the rung that set it, in the headings' order. A heading the outline lists
 * takes its level; in a document where enough headings carry a section number, a numbered heading
 * takes its depth; an unnumbered heading after an outline heading goes one level below it; any other
 * heading is levelled by its text size.
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
  const depths = new Map(rest.map((i) => [i, numberDepth(headings[i]?.text ?? '')]));
  const numbered = rest.filter((i) => depths.get(i) !== undefined);
  const byNumber = rest.length > 0 && numbered.length / rest.length >= minNumberedShare;
  if (byNumber)
    for (const i of numbered) result[i] = { level: depths.get(i) as number, source: 'number' };

  // One level below the nearest outline heading before it (issue 516, Q1).
  let inForce: number | undefined;
  for (let i = 0; i < headings.length; i += 1) {
    if (fromOutline.has(i)) inForce = fromOutline.get(i);
    else if (!result[i] && inForce !== undefined)
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
    for (const i of bySize) {
      const size = sizes.get(i)?.size;
      let level = 1;
      if (size !== undefined && medians.length > 0 && !(first !== undefined && size > first + 1))
        level = [...medians].sort(
          (a, b) => Math.abs(a[1] - size) - Math.abs(b[1] - size) || a[0] - b[0],
        )[0]?.[0] as number;
      result[i] = { level, source: sourceOf(i) };
    }
  } else {
    // Sizes to the half point, ranked from the biggest; a size only one heading has joins the nearest
    // size more have. Ranked over every heading the size rung could level, as the prototype does.
    const half = new Map(
      rest.flatMap((i) => {
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
      const level = size === undefined ? 1 : Math.min(order.indexOf(snap(size)) + 1, maxSizeLevels);
      result[i] = { level, source: sourceOf(i) };
    }
  }
  return result.map((r) => r ?? { level: 1, source: 'size-box' });
};
