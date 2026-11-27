/**
 * Parts from a `DoclingDocument`, derivation `docling-parts` 1 (ADR 0055): every item in reading
 * order, furniture included, with a region on every page it covers and its span of the conversion's
 * text, stored one row a page. Given the PDF's layout, `docling-parts` 2: the same parts, with each
 * heading's level from the PDF's outline, section number or text size (issue 516). Only `level` and
 * `headingPath` differ, so the text and the chunks made from it are the same.
 */
import {
  codePointLength,
  nfc,
  partKinds,
  type ConversionPart,
  type ConversionUnit,
  type PartBox,
  type PartKind,
  type PartLayer,
  type PartRegion,
} from '@genai/port-knowledge';
import {
  pagesTakingPictureText,
  walkDocling,
  type DoclingBox,
  type DoclingDocument,
  type DoclingNode,
  type DoclingProv,
  type WalkEntry,
} from './docling-walk.js';
import { headingLevels, type LevelledHeading, type PdfLayout } from './heading-levels.js';
import { pageLabels } from './page-labels.js';

const kinds = new Set<string>(partKinds);

const round = (fraction: number) => Math.round(Math.min(Math.max(fraction, 0), 1) * 1e4) / 1e4;

/** A box's top and bottom from the page's top edge; a box without an origin is read by its shape. */
const fromTop = (box: DoclingBox, height: number): [number, number] => {
  const bottomLeft = box.coord_origin ? box.coord_origin === 'BOTTOMLEFT' : box.t > box.b;
  return bottomLeft ? [height - box.t, height - box.b] : [box.t, box.b];
};

const boxOn = (
  provs: DoclingProv[],
  size: { width: number; height: number } | undefined,
): PartBox | undefined => {
  const boxes = provs.flatMap((p) => (p.bbox ? [p.bbox] : []));
  if (!size || boxes.length === 0) return undefined;
  const edges = boxes.map((box) => {
    const [top, bottom] = fromTop(box, size.height);
    return [
      Math.min(box.l, box.r),
      Math.min(top, bottom),
      Math.max(box.l, box.r),
      Math.max(top, bottom),
    ];
  });
  const [x0, y0, x1, y1] = [
    Math.min(...edges.map((e) => e[0] as number)),
    Math.min(...edges.map((e) => e[1] as number)),
    Math.max(...edges.map((e) => e[2] as number)),
    Math.max(...edges.map((e) => e[3] as number)),
  ];
  return [
    round(x0 / size.width),
    round(y0 / size.height),
    round(x1 / size.width),
    round(y1 / size.height),
  ];
};

/** The item's boxes grouped by page, in the order of their first box. */
const byPage = (node: DoclingNode) => {
  const pages = new Map<number, DoclingProv[]>();
  for (const prov of node.prov ?? []) {
    const group = pages.get(prov.page_no);
    if (group) group.push(prov);
    else pages.set(prov.page_no, [prov]);
  }
  return pages;
};

/** The offset in the part's text, collapsed and NFC, of code point `k` of the item's raw text. */
const offsetIn = (raw: string[]) => (k: number) => {
  const prefix = raw.slice(0, k).join('').replace(/\s+/g, ' ').trimStart();
  return { at: codePointLength(nfc(prefix.trimEnd())), space: prefix.endsWith(' ') };
};

/**
 * Where each page's piece starts and ends in the part's text, from the charspans of its boxes, or
 * undefined when the charspans do not cover the text in order.
 */
const splitAt = (node: DoclingNode, pages: Map<number, DoclingProv[]>) => {
  const provs = node.prov ?? [];
  const raw = [...(node.text ?? '')];
  if (node.orig !== undefined && node.orig !== node.text) return undefined;
  const inOrder = provs.every((prov, i) => {
    const before = provs[i - 1];
    const [from, to] = prov.charspan ?? [-1, -1];
    if (from < 0 || from > to) return false;
    if (!before) return from === 0;
    return before.page_no <= prov.page_no && (before.charspan?.[1] ?? Infinity) <= from;
  });
  if (!inOrder || provs.at(-1)?.charspan?.[1] !== raw.length) return undefined;
  const offset = offsetIn(raw);
  return [...pages.values()].map((group) => {
    const from = offset(group[0]?.charspan?.[0] ?? 0);
    return [from.at + (from.space ? 1 : 0), offset(group.at(-1)?.charspan?.[1] ?? 0).at] as const;
  });
};

interface Draft {
  entry: WalkEntry;
  kind: PartKind;
  layer: PartLayer;
  pieces: string[];
}

export interface DoclingPartsOptions {
  /** The PDF's outline and text sizes: given, the parts are `docling-parts` 2. */
  layout?: PdfLayout;
  /** Off only to score the levels against the outline (`headingLevels`). */
  outline?: boolean;
}

const isHeading = (draft: Draft, text: string) =>
  draft.layer === 'body' &&
  text !== '' &&
  (draft.kind === 'title' || draft.kind === 'section_header');

const draftText = (draft: Draft) => nfc(draft.pieces.filter((piece) => piece !== '').join(' '));

/**
 * The levels of the section headers from the PDF, by draft; titles keep the walk's level. Applied
 * after the walk, which `docling-pages` shares, so its pages never change (issue 516).
 */
const levelsFrom = (
  drafts: Draft[],
  walk: ReturnType<typeof walkDocling>,
  options: DoclingPartsOptions,
) => {
  const levels = new Map<number, number>();
  if (!options.layout) return levels;
  const at: number[] = [];
  const headings: LevelledHeading[] = [];
  drafts.forEach((draft, i) => {
    const text = draftText(draft);
    if (!isHeading(draft, text) || draft.kind !== 'section_header') return;
    const [page, provs] = [...byPage(draft.entry.node)][0] ?? [];
    at.push(i);
    headings.push({
      text,
      page,
      box: page !== undefined && provs ? boxOn(provs, walk.sizeOf(page)) : undefined,
      pageHeight: page !== undefined ? walk.sizeOf(page)?.height : undefined,
    });
  });
  const found = headingLevels(headings, options.layout, {
    ...(options.outline === undefined ? {} : { outline: options.outline }),
  });
  found.forEach(({ level }, k) => levels.set(at[k] as number, level));
  return levels;
};

export const doclingParts = (
  document: DoclingDocument,
  options: DoclingPartsOptions = {},
): { units: ConversionUnit[]; unmapped: Record<string, number> } => {
  const walk = walkDocling(document);
  const takesPictureText = pagesTakingPictureText(walk);
  const unmapped: Record<string, number> = {};

  const drafts: Draft[] = [];
  const pictures = new Map<string, Draft>();
  for (const entry of walk.entries) {
    const ref = entry.node.self_ref;
    const isText = !ref.startsWith('#/tables/') && !ref.startsWith('#/pictures/');
    if (entry.picture && isText) {
      const owner = pictures.get(entry.picture);
      // As in docling-pages: only text it writes, and only on a page that takes picture text.
      const counts = entry.markdown !== undefined && takesPictureText.has(entry.page ?? 0);
      if (owner && counts) owner.pieces.push(entry.text);
      continue;
    }
    const group = ref.startsWith('#/groups/');
    let kind: PartKind = 'text';
    if (!group && kinds.has(entry.label)) kind = entry.label as PartKind;
    else if (!group) unmapped[entry.label] = (unmapped[entry.label] ?? 0) + 1;
    // A page number Docling left in the body is furniture, as docling-pages leaves it out.
    const layer = (entry.pageNumber ? 'furniture' : entry.layer) as PartLayer;
    const draft: Draft = { entry, kind, layer, pieces: [entry.text] };
    drafts.push(draft);
    if (ref.startsWith('#/pictures/')) pictures.set(ref, draft);
  }

  const levels = levelsFrom(drafts, walk, options);
  let length = 0;
  const headings: { level: number; text: string }[] = [];
  const parts: ConversionPart[] = drafts.map((draft, seq) => {
    const { entry, kind, layer } = draft;
    const text = draftText(draft);
    const body = layer === 'body';
    let start: number | null = null;
    let end: number | null = null;
    if (body) {
      const size = codePointLength(text);
      start = size > 0 && length > 0 ? length + 2 : length;
      end = start + size;
      if (size > 0) length = end;
    }
    const heading = isHeading(draft, text);
    const level = heading ? (levels.get(seq) ?? entry.level ?? 1) : null;
    while (heading && (headings.at(-1)?.level ?? 0) >= (level ?? 0)) headings.pop();
    const headingPath = headings.map((h) => h.text);
    if (heading) headings.push({ level: level ?? 1, text });

    const pages = byPage(entry.node);
    const spans =
      body && entry.node.self_ref.startsWith('#/texts/') && pages.size > 1
        ? splitAt(entry.node, pages)
        : undefined;
    const regions: PartRegion[] = [...pages.entries()].map(([unit, provs], i) => {
      const box = boxOn(provs, walk.sizeOf(unit));
      const span = spans?.[i];
      return {
        unit,
        ...(box ? { box } : {}),
        start: start !== null && span ? start + span[0] : start,
        end: start !== null && span ? start + span[1] : end,
      };
    });
    return {
      seq,
      kind,
      layer,
      level,
      headingPath,
      text,
      start,
      end,
      regions,
      native: entry.node.self_ref,
    };
  });

  const rows = new Map<number, ConversionPart[]>();
  let row = 1;
  for (const part of parts) {
    const first = Math.min(...part.regions.map((region) => region.unit));
    row = Number.isFinite(first) ? Math.max(row, first) : row;
    const held = rows.get(row);
    if (held) held.push(part);
    else rows.set(row, [part]);
  }

  let next = 0;
  const units: ConversionUnit[] = Array.from({ length: walk.pageCount }, (_, i) => {
    const unit = i + 1;
    const held = rows.get(unit) ?? [];
    const size = walk.sizeOf(unit);
    const spans = held.filter((part) => part.start !== null);
    const seqFrom = next;
    next += held.length;
    return {
      unit,
      kind: 'page',
      label: null,
      width: size?.width ?? null,
      height: size?.height ?? null,
      textStart: spans.length > 0 ? Math.min(...spans.map((part) => part.start as number)) : null,
      textEnd: spans.length > 0 ? Math.max(...spans.map((part) => part.end as number)) : null,
      unitTo: Math.max(unit, ...held.flatMap((part) => part.regions.map((region) => region.unit))),
      seqFrom,
      seqTo: seqFrom + held.length - 1,
      parts: held,
    };
  });
  const labels = pageLabels(units);
  return { units: units.map((unit, i) => ({ ...unit, label: labels[i] ?? null })), unmapped };
};
