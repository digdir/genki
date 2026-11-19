import type { DoclingDocument } from './docling-walk.js';

type Item = Record<string, unknown> & { self_ref: string };

export const pageWidth = 600;
export const pageHeight = 800;

/** One box of an item: its page, its top in points from the page's top edge, and its charspan. */
export interface Place {
  page: number;
  top?: number | undefined;
  lineHeight?: number;
  /** Writes the box from the top left instead of from the bottom left. */
  fromTop?: boolean | undefined;
  charspan?: [number, number];
}

const codePoints = (text: string) => [...text].length;

/** A box as Docling writes it, BOTTOMLEFT unless `fromTop`. */
const box = (
  { page, top = 300, lineHeight = 12, fromTop = false, charspan }: Place,
  text = '',
) => ({
  page_no: page,
  bbox: fromTop
    ? { l: 50, t: top, r: 300, b: top + lineHeight, coord_origin: 'TOPLEFT' }
    : {
        l: 50,
        t: pageHeight - top,
        r: 300,
        b: pageHeight - top - lineHeight,
        coord_origin: 'BOTTOMLEFT',
      },
  charspan: charspan ?? [0, codePoints(text)],
});

export interface TextOptions {
  parent?: string;
  layer?: string;
  top?: number;
  fromTop?: boolean;
  /** Several boxes, on one page or more, in place of the one on `page`. */
  places?: Place[];
}

export interface Adder {
  text(label: string, text: string, page: number, options?: TextOptions): string;
  group(label: string, parent?: string): string;
  table(
    page: number,
    rows: string[][],
    parent?: string,
    headerRows?: number,
    label?: string,
  ): string;
  picture(page: number): string;
  caption(owner: string, text: string, page: number): string;
}

/** Builds a DoclingDocument from items in reading order, each placed under the body or a parent. */
export const doc = (pages: number, build: (add: Adder) => void): DoclingDocument => {
  const texts: Item[] = [];
  const groups: Item[] = [];
  const tables: Item[] = [];
  const pictures: Item[] = [];
  const body = { self_ref: '#/body', children: [] as { $ref: string }[] };
  const all = new Map<string, Item | typeof body>([['#/body', body]]);
  const attach = (item: Item, parent?: string) => {
    const owner = all.get(parent ?? '#/body') as { children: { $ref: string }[] };
    owner.children.push({ $ref: item.self_ref });
    item.parent = { $ref: parent ?? '#/body' };
    all.set(item.self_ref, item);
    return item.self_ref;
  };
  const add: Adder = {
    text: (label, text, page, options = {}) => {
      const places = options.places ?? [{ page, top: options.top, fromTop: options.fromTop }];
      const item: Item = {
        self_ref: `#/texts/${texts.length}`,
        children: [],
        content_layer: options.layer ?? (/page_(header|footer)/.test(label) ? 'furniture' : 'body'),
        label,
        prov: places.map((place) => box(place, text)),
        orig: text,
        text,
      };
      texts.push(item);
      return attach(item, options.parent);
    },
    group: (label, parent) => {
      const item: Item = {
        self_ref: `#/groups/${groups.length}`,
        children: [],
        content_layer: 'body',
        label,
        name: label,
      };
      groups.push(item);
      return attach(item, parent);
    },
    table: (page, rows, parent, headerRows = 0, label = 'table') => {
      const item: Item = {
        self_ref: `#/tables/${tables.length}`,
        children: [],
        content_layer: 'body',
        label,
        prov: [box({ page })],
        captions: [],
        data: {
          num_rows: rows.length,
          num_cols: rows[0]?.length ?? 0,
          grid: rows.map((row, r) => row.map((text) => ({ text, column_header: r < headerRows }))),
        },
      };
      tables.push(item);
      return attach(item, parent);
    },
    picture: (page) => {
      const item: Item = {
        self_ref: `#/pictures/${pictures.length}`,
        children: [],
        content_layer: 'body',
        label: 'picture',
        prov: [box({ page })],
        captions: [],
      };
      pictures.push(item);
      return attach(item);
    },
    caption: (owner, text, page) => {
      const ref = add.text('caption', text, page, { parent: owner });
      ((all.get(owner) as Item).captions as { $ref: string }[]).push({ $ref: ref });
      return ref;
    },
  };
  build(add);
  return {
    body,
    texts,
    groups,
    tables,
    pictures,
    pages: Object.fromEntries(
      Array.from({ length: pages }, (_, i) => [
        String(i + 1),
        { page_no: i + 1, size: { width: pageWidth, height: pageHeight } },
      ]),
    ),
  };
};
