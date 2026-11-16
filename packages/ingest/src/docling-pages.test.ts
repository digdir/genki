import { describe, expect, it } from 'vitest';
import { doclingPages, type DoclingDocument } from './docling-pages.js';

type Item = Record<string, unknown> & { self_ref: string };

const height = 800;
/** A box on a page, its top `top` points from the page's top edge, as Docling writes BOTTOMLEFT boxes. */
const prov = (page: number, top = 300, lineHeight = 12, fromTop = false) => [
  {
    page_no: page,
    bbox: fromTop
      ? { l: 50, t: top, r: 300, b: top + lineHeight, coord_origin: 'TOPLEFT' }
      : {
          l: 50,
          t: height - top,
          r: 300,
          b: height - top - lineHeight,
          coord_origin: 'BOTTOMLEFT',
        },
    charspan: [0, 1],
  },
];

/** Builds a DoclingDocument from items in reading order, each placed under the body or a parent. */
const doc = (pages: number, build: (add: Adder) => void): DoclingDocument => {
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
      const item: Item = {
        self_ref: `#/texts/${texts.length}`,
        children: [],
        content_layer: options.layer ?? (/page_(header|footer)/.test(label) ? 'furniture' : 'body'),
        label,
        prov: prov(page, options.top, 12, options.fromTop),
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
    table: (page, rows, parent, headerRows = 0) => {
      const item: Item = {
        self_ref: `#/tables/${tables.length}`,
        children: [],
        content_layer: 'body',
        label: 'table',
        prov: prov(page),
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
        prov: prov(page),
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
        { page_no: i + 1, size: { width: 600, height } },
      ]),
    ),
  };
};

interface Adder {
  text(
    label: string,
    text: string,
    page: number,
    options?: { parent?: string; layer?: string; top?: number; fromTop?: boolean },
  ): string;
  group(label: string, parent?: string): string;
  table(page: number, rows: string[][], parent?: string, headerRows?: number): string;
  picture(page: number): string;
  caption(owner: string, text: string, page: number): string;
}

describe('docling-pages', () => {
  it("page headers and footers are not in a seeded conversion's pages", () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('page_header', 'Årsrapport 2023', 1, { top: 20 });
        add.text('text', 'Budsjettet ble overholdt.', 1);
        add.text('page_footer', 'Side 1 av 1', 1, { top: 780 });
      }),
    );
    expect(pages).toEqual(['Budsjettet ble overholdt.']);
  });

  it('a page whose only text is inside pictures takes that text', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        const picture = add.picture(1);
        add.text('text', 'Organisasjonskart', 1, { parent: picture });
        add.text('text', 'Direktør', 1, { parent: picture });
      }),
    );
    expect(pages).toEqual(['Organisasjonskart\n\nDirektør']);
  });

  it('leaves out text inside a picture on a page with other text', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('text', 'Lønnsutviklingen i staten var 5,2 prosent i 2023.', 1);
        const picture = add.picture(1);
        add.text('text', '2018 2019 2020', 1, { parent: picture });
      }),
    );
    expect(pages).toEqual(['Lønnsutviklingen i staten var 5,2 prosent i 2023.']);
  });

  it("a numbered heading takes the level of its number's depth", () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('section_header', '2 Mål og resultater', 1);
        add.text('section_header', '2.1 Bakgrunn', 1);
        add.text('section_header', '2.1.3 Tiltak', 1);
        add.text('section_header', '3. Ressurser', 1);
      }),
    );
    expect(pages[0]?.split('\n\n')).toEqual([
      '# 2 Mål og resultater',
      '## 2.1 Bakgrunn',
      '### 2.1.3 Tiltak',
      '# 3. Ressurser',
    ]);
  });

  it('in a document where fewer than 30 % of headings are numbered, every heading stays level 1', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('section_header', '2.1 Bakgrunn', 1);
        add.text('section_header', 'Innledning', 1);
        add.text('section_header', 'Mål', 1);
        add.text('section_header', 'Resultater', 1);
      }),
    );
    expect(pages[0]?.split('\n\n')).toEqual([
      '# 2.1 Bakgrunn',
      '# Innledning',
      '# Mål',
      '# Resultater',
    ]);
  });

  it('an unnumbered heading in a numbered document stays level 1', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('section_header', '1 Innledning', 1);
        add.text('section_header', '1.1 Formål', 1);
        add.text('section_header', 'Vedlegg', 1);
      }),
    );
    expect(pages[0]?.split('\n\n')).toEqual(['# 1 Innledning', '## 1.1 Formål', '# Vedlegg']);
  });

  it('a section number deeper than four levels gives level 4', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('section_header', '1.2.3.4.5 Detalj', 1);
      }),
    );
    expect(pages).toEqual(['#### 1.2.3.4.5 Detalj']);
  });

  it('a heading that starts with a year is not numbered', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('section_header', '2023 i korte trekk', 1);
        add.text('section_header', '2024 og videre', 1);
      }),
    );
    expect(pages[0]?.split('\n\n')).toEqual(['# 2023 i korte trekk', '# 2024 og videre']);
  });

  it("a document's title is a level 1 heading and does not count toward the numbered share", () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('title', 'Tildelingsbrev 2022', 1);
        add.text('section_header', '1 Innledning', 1);
        add.text('section_header', '1.1 Formål', 1);
      }),
    );
    expect(pages[0]?.split('\n\n')).toEqual([
      '# Tildelingsbrev 2022',
      '# 1 Innledning',
      '## 1.1 Formål',
    ]);
  });

  it('gives every page of the document an entry, empty when it has no text', () => {
    const pages = doclingPages(
      doc(3, (add) => {
        add.text('text', 'Første side.', 1);
        add.text('text', 'Tredje side.', 3);
      }),
    );
    expect(pages).toEqual(['Første side.', '', 'Tredje side.']);
  });

  it('leaves out empty items', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('text', '   ', 1);
        add.text('section_header', '', 1);
        add.text('text', 'Innhold.', 1);
      }),
    );
    expect(pages).toEqual(['Innhold.']);
  });

  it('writes a table as a Markdown table', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.table(1, [
          ['Post', 'Beløp'],
          ['Lønn | drift', '1 200'],
        ]);
      }),
    );
    expect(pages).toEqual(['| Post | Beløp |\n| --- | --- |\n| Lønn \\| drift | 1 200 |']);
  });

  it('writes the items of a list on lines of their own', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('text', 'Virksomheten skal:', 1);
        const list = add.group('list');
        add.text('list_item', 'rapportere innen 1. mars', 1, { parent: list });
        add.text('list_item', 'følge opp tiltakene', 1, { parent: list });
      }),
    );
    expect(pages).toEqual([
      'Virksomheten skal:\n\n- rapportere innen 1. mars\n- følge opp tiltakene',
    ]);
  });

  it('joins the parts of an inline group into one paragraph', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        const inline = add.group('inline');
        add.text('text', 'Se', 1, { parent: inline });
        add.text('text', 'kapittel 3', 1, { parent: inline });
        add.text('text', 'for detaljer.', 1, { parent: inline });
      }),
    );
    expect(pages).toEqual(['Se kapittel 3 for detaljer.']);
  });

  it('puts each item on the page of its first box', () => {
    const pages = doclingPages(
      doc(2, (add) => {
        add.text('text', 'Side én.', 1);
        add.text('section_header', 'Side to', 2);
        add.text('text', 'Mer på side to.', 2);
      }),
    );
    expect(pages).toEqual(['Side én.', '# Side to\n\nMer på side to.']);
  });

  it('a page with under 20 characters of other text takes its picture text', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('text', 'Vedlegg 2', 1);
        const picture = add.picture(1);
        add.text('text', 'Organisasjonskart', 1, { parent: picture });
      }),
    );
    expect(pages).toEqual(['Vedlegg 2\n\nOrganisasjonskart']);
  });

  it("a picture's caption stays in the page", () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('text', 'Lønnsutviklingen i staten var 5,2 prosent i 2023.', 1);
        const picture = add.picture(1);
        add.caption(picture, 'Figur 3: Utvikling i lønn 2018–2023', 1);
        add.text('text', '2018 2019 2020', 1, { parent: picture });
      }),
    );
    expect(pages).toEqual([
      'Lønnsutviklingen i staten var 5,2 prosent i 2023.\n\nFigur 3: Utvikling i lønn 2018–2023',
    ]);
  });

  it('a lone number at the top or bottom of a page is left out', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('text', '- 6 -', 1, { top: 15 });
        add.text('text', 'Budsjettet ble overholdt.', 1);
        add.text('text', '6', 1, { top: 770 });
      }),
    );
    expect(pages).toEqual(['Budsjettet ble overholdt.']);
  });

  it('a lone number in the middle of a page stays', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('text', 'Innledning', 1, { top: 300 });
        add.text('text', '41', 1, { top: 320 });
      }),
    );
    expect(pages).toEqual(['Innledning\n\n41']);
  });

  it('joins a column header of several rows into one header row', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.table(
          1,
          [
            ['Varighet', 'Type eiendel', 'Type eiendel'],
            ['Varighet', 'Maskiner', 'Sum'],
            ['Under 1 år', '1 200', '206 932 833'],
          ],
          undefined,
          2,
        );
      }),
    );
    expect(pages).toEqual([
      '| Varighet | Type eiendel - Maskiner | Type eiendel - Sum |\n| --- | --- | --- |\n| Under 1 år | 1 200 | 206 932 833 |',
    ]);
  });

  it('a caption does not count toward the text that keeps picture text out', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        const picture = add.picture(1);
        add.caption(picture, 'Figur 3: Organisasjonskart for direktoratet', 1);
        add.text('text', 'Direktør', 1, { parent: picture });
      }),
    );
    expect(pages).toEqual(['Figur 3: Organisasjonskart for direktoratet\n\nDirektør']);
  });

  it('escapes a backslash and a bar in a table cell', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.table(1, [
          ['Sti', 'Merknad'],
          ['C:\\data\\', 'a | b'],
        ]);
      }),
    );
    expect(pages).toEqual(['| Sti | Merknad |\n| --- | --- |\n| C:\\\\data\\\\ | a \\| b |']);
  });

  it('a lone number at the edge of a page is left out when its box is measured from the top', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        add.text('text', '7', 1, { top: 15, fromTop: true });
        add.text('text', 'Innhold.', 1, { top: 300, fromTop: true });
        add.text('text', '8', 1, { top: 780, fromTop: true });
        add.text('text', '9', 1, { top: 400, fromTop: true });
      }),
    );
    expect(pages).toEqual(['Innhold.\n\n9']);
  });

  it('numbers the items of an ordered list', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        const list = add.group('ordered_list');
        add.text('list_item', 'Søk innen 1. mars', 1, { parent: list });
        add.text('list_item', 'Rapporter året etter', 1, { parent: list });
      }),
    );
    expect(pages).toEqual(['1. Søk innen 1. mars\n2. Rapporter året etter']);
  });

  it('a list item whose text is an inline group keeps its bullet', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        const list = add.group('list');
        const item = add.text('list_item', '', 1, { parent: list });
        const inline = add.group('inline', item);
        add.text('text', 'Les', 1, { parent: inline });
        add.text('text', 'veilederen', 1, { parent: inline });
      }),
    );
    expect(pages).toEqual(['- Les veilederen']);
  });

  it('an inline group inside an inline group keeps its text', () => {
    const pages = doclingPages(
      doc(1, (add) => {
        const outer = add.group('inline');
        add.text('text', 'Se', 1, { parent: outer });
        const inner = add.group('inline', outer);
        add.text('text', 'kapittel', 1, { parent: inner });
        add.text('text', '3', 1, { parent: inner });
        add.text('text', 'for detaljer.', 1, { parent: outer });
      }),
    );
    expect(pages).toEqual(['Se kapittel 3 for detaljer.']);
  });
});
