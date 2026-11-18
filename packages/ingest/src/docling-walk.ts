/**
 * The walk over a `DoclingDocument` that both of its derivations share: `docling-pages` 1 (ADR 0042,
 * "Conversion") and `docling-parts` 1 (ADR 0055). It gives every item in reading order with its
 * plain text and the Markdown the pages write for it.
 */

interface Ref {
  $ref: string;
}

export interface DoclingBox {
  l: number;
  t: number;
  r: number;
  b: number;
  coord_origin?: string;
}

export interface DoclingProv {
  page_no: number;
  bbox?: DoclingBox;
  charspan?: [number, number];
}

interface GridCell {
  text?: string;
  column_header?: boolean;
}

export interface DoclingNode {
  self_ref: string;
  label?: string;
  content_layer?: string;
  children?: Ref[];
  captions?: Ref[];
  prov?: DoclingProv[];
  orig?: string;
  text?: string;
  enumerated?: boolean;
  marker?: string;
  data?: { grid?: GridCell[][] };
}

/** A `DoclingDocument` as Docling's `export_to_dict` writes it: only the parts the derivations read. */
export interface DoclingDocument {
  body: { children?: Ref[] };
  furniture?: { children?: Ref[] };
  texts: unknown[];
  groups?: unknown[];
  tables?: unknown[];
  pictures?: unknown[];
  pages: Record<string, { page_no?: number; size?: { width: number; height: number } }>;
}

/** Under this many characters of other text, captions not counted, a page takes its pictures' text. */
const pictureTextBelow = 20;
const maxHeadingLevel = 4;
/** At least this share of a document's headings must carry a section number to level them by it. */
const minNumberedShare = 0.3;
const sectionNumber = /^[\s#*]*(\d+(?:\.\d+)*)\.?\s+\S/;
const bareNumber = /^[-–—\s]*\d{1,4}[-–—\s]*$/;
/** A bare number this close to the top or bottom edge, as a share of the page's height, is a page number. */
const pageEdge = 0.1;

export const textOf = (node: DoclingNode) => (node.text ?? '').replace(/\s+/g, ' ').trim();

/** The depth of a leading section number ("2.1" = 2), or undefined when there is none. */
const numberDepth = (heading: string) => {
  const match = sectionNumber.exec(heading.normalize('NFKC'));
  if (!match?.[1]) return undefined;
  const parts = match[1].split('.');
  // A year or a long number is not a section number.
  if (parts.length === 1 && (parts[0] ?? '').length > 2) return undefined;
  return parts.length;
};

const cell = (text: string | undefined) =>
  (text ?? '').replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/**
 * How many leading rows form the column header: the run of rows with a cell marked as one, and no
 * other text outside the first column; the first row when no cell is marked.
 */
const headerRowCount = (grid: GridCell[][]) => {
  if (!grid.some((row) => row.some((c) => c.column_header))) return 1;
  let count = 0;
  for (const row of grid) {
    const marked = row.some((c) => c.column_header);
    const body = row.some((c, col) => col > 0 && !c.column_header && cell(c.text) !== '');
    if (!marked || (count > 0 && body)) break;
    count += 1;
  }
  return Math.max(count, 1);
};

/** Stacked header rows as one, per column joined with " - " as Docling's own Markdown does. */
const flattenHeader = (rows: string[][]) =>
  (rows[0] ?? []).map((_, col) =>
    rows
      .reduce<string[]>((parts, row) => {
        const text = row[col] ?? '';
        return text === '' || text === parts.at(-1) ? parts : [...parts, text];
      }, [])
      .join(' - '),
  );

const markdownTable = (grid: GridCell[][]) => {
  const rows = grid.map((row) => row.map((c) => cell(c.text)));
  if (rows.length === 0 || rows.every((row) => row.every((c) => c === ''))) return undefined;
  const headers = headerRowCount(grid);
  const header = flattenHeader(rows.slice(0, headers));
  const line = (row: string[]) => `| ${row.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.slice(headers).map(line)].join('\n');
};

/** One item of the walk, in reading order. */
export interface WalkEntry {
  node: DoclingNode;
  /** Docling's label; `text` when it has none. */
  label: string;
  /** Docling's `content_layer`; `body` when it has none. */
  layer: string;
  /** Whitespace-collapsed text; a table's Markdown table; empty for a picture. */
  text: string;
  /** What `docling-pages` writes for the item, or undefined when it leaves it out. */
  markdown: string | undefined;
  /** The characters that count as the page's other text: a table's cells only. */
  chars: number;
  /** The page of the item's first box, or of its first descendant that has one. */
  page: number | undefined;
  /** A lone number at the page's top or bottom edge: a page number Docling left in the body. */
  pageNumber: boolean;
  /** A heading's level. */
  level?: number;
  /** The picture the item is inside, by `self_ref`. */
  picture?: string;
  /** A picture's caption: kept, but not counted as other text on its page. */
  caption: boolean;
  /** The outermost list the item is in, by `self_ref`, so its items are written on lines of their own. */
  list?: string;
}

export interface Walk {
  entries: WalkEntry[];
  pageCount: number;
  sizeOf: (page: number) => { width: number; height: number } | undefined;
}

interface Context {
  /** Outside the body layer, or under a page header or footer: `docling-pages` leaves it out. */
  hidden: boolean;
  picture?: string;
  caption?: boolean;
  list?: { ref: string; depth: number; ordered: boolean; counter: { n: number } };
}

export const walkDocling = (document: DoclingDocument): Walk => {
  const nodes = new Map<string, DoclingNode>();
  for (const list of [document.texts, document.groups, document.tables, document.pictures])
    for (const item of (list ?? []) as DoclingNode[]) nodes.set(item.self_ref, item);

  const pageCount = Math.max(
    0,
    ...Object.entries(document.pages).map(([key, page]) => page.page_no ?? Number(key)),
    ...[...nodes.values()].flatMap((n) => (n.prov ?? []).map((p) => p.page_no)),
  );
  const sizeOf = (page: number) => document.pages[String(page)]?.size;

  const layerOf = (node: DoclingNode) => node.content_layer ?? 'body';
  const inBody = (node: DoclingNode) => layerOf(node) === 'body';

  const headings = [...nodes.values()].filter(
    (n) => n.label === 'section_header' && inBody(n) && textOf(n) !== '',
  );
  const numbered = headings.filter((n) => numberDepth(textOf(n)) !== undefined).length;
  const byNumber = headings.length > 0 && numbered / headings.length >= minNumberedShare;
  const headingLevel = (text: string) =>
    byNumber ? Math.min(numberDepth(text) ?? 1, maxHeadingLevel) : 1;

  /** A lone number at the page's top or bottom edge. */
  const isPageNumber = (node: DoclingNode, text: string) => {
    if (!bareNumber.test(text)) return false;
    const first = node.prov?.[0];
    const height = first && sizeOf(first.page_no)?.height;
    if (!first?.bbox || !height) return false;
    // The two edge bands mirror each other, so a box counts the same from the top or the bottom.
    const { t, b } = first.bbox;
    return Math.max(t, b) < pageEdge * height || Math.min(t, b) > (1 - pageEdge) * height;
  };

  const entries: WalkEntry[] = [];
  const firstPage = (node: DoclingNode): number | undefined => {
    const own = node.prov?.[0]?.page_no;
    if (own !== undefined) return own;
    for (const child of node.children ?? []) {
      const found = nodes.get(child.$ref);
      const page = found && firstPage(found);
      if (page !== undefined) return page;
    }
    return undefined;
  };

  const emit = (
    node: DoclingNode,
    context: Context,
    entry: Pick<WalkEntry, 'text' | 'markdown' | 'chars'> & Partial<WalkEntry>,
  ) => {
    entries.push({
      node,
      label: node.label ?? 'text',
      layer: layerOf(node),
      page: firstPage(node),
      caption: context.caption === true,
      pageNumber: false,
      ...(context.picture ? { picture: context.picture } : {}),
      ...entry,
      markdown: context.hidden ? undefined : entry.markdown,
    });
  };

  /** The text of an inline group's parts, groups inside it included, joined with spaces. */
  const inlineText = (node: DoclingNode): string =>
    (node.children ?? [])
      .map((c) => nodes.get(c.$ref))
      .filter((n): n is DoclingNode => n !== undefined && inBody(n))
      .map((n) => (n.label === 'inline' ? inlineText(n) : textOf(n)))
      .filter((t) => t !== '')
      .join(' ');

  const markdownOf = (node: DoclingNode, label: string, text: string, context: Context) => {
    if (label === 'title') return `# ${text}`;
    if (label === 'section_header') return `${'#'.repeat(headingLevel(text))} ${text}`;
    if (label === 'list_item' && context.list) {
      const { list } = context;
      list.counter.n += 1;
      const bullet = list.ordered ? `${list.counter.n}.` : '-';
      return `${'  '.repeat(list.depth)}${bullet} ${text}`;
    }
    if (label === 'list_item') return `- ${text}`;
    if (label === 'code') return `\`\`\`\n${node.text ?? ''}\n\`\`\``;
    if (label === 'checkbox_selected') return `- [x] ${text}`;
    if (label === 'checkbox_unselected') return `- [ ] ${text}`;
    return text;
  };

  const renderText = (node: DoclingNode, context: Context) => {
    const label = node.label ?? 'text';
    // A list item's text may sit in an inline group under it instead of on the item.
    const inlineParts =
      label === 'list_item' && textOf(node) === ''
        ? (node.children ?? []).filter((c) => nodes.get(c.$ref)?.label === 'inline')
        : [];
    const text =
      textOf(node) ||
      inlineParts
        .map((c) => inlineText(nodes.get(c.$ref) as DoclingNode))
        .filter((t) => t !== '')
        .join(' ');
    const own: Context =
      label === 'page_header' || label === 'page_footer' ? { ...context, hidden: true } : context;
    const pageNumber = text !== '' && isPageNumber(node, text);
    const written = !own.hidden && text !== '' && !pageNumber;
    emit(node, own, {
      text,
      pageNumber,
      markdown: written ? markdownOf(node, label, text, own) : undefined,
      chars: text.length,
      ...(label === 'title' ? { level: 1 } : {}),
      ...(label === 'section_header' ? { level: headingLevel(text) } : {}),
      ...(label === 'list_item' && own.list ? { list: own.list.ref } : {}),
    });
    for (const child of node.children ?? [])
      if (!inlineParts.includes(child)) visit(child.$ref, own);
  };

  const renderGroup = (node: DoclingNode, context: Context) => {
    if (node.label === 'inline') {
      const text = inlineText(node);
      emit(node, context, {
        text,
        markdown: text === '' ? undefined : text,
        chars: text.length,
        ...(context.list ? { list: context.list.ref } : {}),
      });
      return;
    }
    if (node.label === 'list' || node.label === 'ordered_list') {
      const depth = context.list ? context.list.depth + 1 : 0;
      const ordered =
        node.label === 'ordered_list' ||
        (node.children ?? []).some((c) => nodes.get(c.$ref)?.enumerated === true);
      visitChildren(node, {
        ...context,
        list: { ref: context.list?.ref ?? node.self_ref, depth, ordered, counter: { n: 0 } },
      });
      return;
    }
    visitChildren(node, context);
  };

  const renderTable = (node: DoclingNode, context: Context) => {
    const captions = new Set((node.captions ?? []).map((c) => c.$ref));
    for (const ref of captions) visit(ref, context);
    const table = (node.data?.grid && markdownTable(node.data.grid)) || '';
    const chars = (node.data?.grid ?? []).flat().reduce((sum, c) => sum + cell(c.text).length, 0);
    emit(node, context, { text: table, markdown: table || undefined, chars });
    for (const child of node.children ?? [])
      if (!captions.has(child.$ref)) visit(child.$ref, context);
  };

  const renderPicture = (node: DoclingNode, context: Context) => {
    const captions = new Set((node.captions ?? []).map((c) => c.$ref));
    for (const ref of captions) visit(ref, { ...context, caption: true });
    emit(node, context, { text: '', markdown: undefined, chars: 0 });
    for (const child of node.children ?? [])
      if (!captions.has(child.$ref))
        visit(child.$ref, { hidden: context.hidden, picture: node.self_ref });
  };

  const visitChildren = (node: DoclingNode, context: Context) => {
    for (const child of node.children ?? []) visit(child.$ref, context);
  };

  const visit = (ref: string, context: Context) => {
    const node = nodes.get(ref);
    if (!node) return;
    const own = inBody(node) ? context : { ...context, hidden: true };
    if (ref.startsWith('#/texts/')) renderText(node, own);
    else if (ref.startsWith('#/tables/')) renderTable(node, own);
    else if (ref.startsWith('#/pictures/')) renderPicture(node, own);
    else renderGroup(node, own);
  };

  for (const child of document.body.children ?? []) visit(child.$ref, { hidden: false });
  for (const child of document.furniture?.children ?? []) visit(child.$ref, { hidden: true });

  return { entries, pageCount, sizeOf };
};

/**
 * The pages whose pictures' text counts: under 20 characters of other text that `docling-pages`
 * writes, captions not counted.
 */
export const pagesTakingPictureText = ({ entries, pageCount }: Walk) => {
  const other = new Array<number>(pageCount + 1).fill(0);
  for (const entry of entries)
    if (entry.markdown !== undefined && !entry.picture && !entry.caption && entry.page)
      other[entry.page] = (other[entry.page] ?? 0) + entry.chars;
  return new Set(
    other.flatMap((chars, page) => (page > 0 && chars < pictureTextBelow ? [page] : [])),
  );
};
