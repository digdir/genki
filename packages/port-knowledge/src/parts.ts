/**
 * Conversion parts and the unit rows that store them (ADR 0055, "The part", "Units and places",
 * "Units and storage").
 */

/** Docling's `DocItemLabel` values a part keeps; any other label becomes `text`. */
export const partKinds = [
  'title',
  'section_header',
  'text',
  'list_item',
  'table',
  'document_index',
  'picture',
  'caption',
  'footnote',
  'formula',
  'code',
  'checkbox_selected',
  'checkbox_unselected',
  'page_header',
  'page_footer',
] as const;

export type PartKind = (typeof partKinds)[number];

/** Docling's `ContentLayer` values. Only `body` parts are chunked or cited. */
export type PartLayer = 'body' | 'furniture' | 'notes' | 'background' | 'invisible';

/** `[x0, y0, x1, y1]` as fractions of the unit from its top left. */
export type PartBox = [number, number, number, number];

/** A part's place in one unit it covers, and its span of the conversion's text there. */
export interface PartRegion {
  unit: number;
  box?: PartBox;
  /** Null for furniture. */
  start: number | null;
  end: number | null;
}

export interface ConversionPart {
  /** Reading order from 0, unique in the conversion. */
  seq: number;
  kind: PartKind;
  layer: PartLayer;
  /** A heading's level, else null. */
  level: number | null;
  /** The texts of the headings above the part, outermost first. */
  headingPath: string[];
  /** Plain text; a table as a Markdown table. */
  text: string;
  /** Tables only, built from the converter's cells. */
  html?: string;
  /** The part's span of the conversion's text, in code points; null for furniture. */
  start: number | null;
  end: number | null;
  /** One per unit the part covers. */
  regions: PartRegion[];
  /** Where the part came from in the native output, such as Docling's `self_ref`. */
  native: string;
}

/**
 * The conversion's text: the `text` of its body parts in `seq` order, joined by a blank line. A part
 * with no text adds nothing. It is not stored; it is rebuilt from the parts.
 */
export const conversionText = (parts: readonly ConversionPart[]) =>
  [...parts]
    .sort((a, b) => a.seq - b.seq)
    .filter((part) => part.layer === 'body' && part.text !== '')
    .map((part) => part.text)
    .join('\n\n');

export type UnitKind = 'page' | 'slide' | 'sheet' | 'section';

/** One row of `src_conversion_units`: a unit and the parts that start in it. */
export interface ConversionUnit {
  /** From 1, in reading order. */
  unit: number;
  kind: UnitKind;
  /** What a reader cites the unit by, when known. */
  label: string | null;
  /** Points, for units with fixed coordinates. */
  width: number | null;
  height: number | null;
  /** The span of the conversion's text that this row's parts cover; null when none has one. */
  textStart: number | null;
  textEnd: number | null;
  /** The last unit a part of this row reaches. */
  unitTo: number;
  seqFrom: number;
  /** `seqFrom - 1` when the row holds no parts. */
  seqTo: number;
  parts: ConversionPart[];
}
