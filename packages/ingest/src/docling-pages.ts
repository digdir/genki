/**
 * Pages from a `DoclingDocument`, derivation `docling-pages` 1 (ADR 0042, "Conversion"): the body
 * in reading order, grouped by the page of each item's first box, without furniture, empty items
 * and bare page numbers. Text inside a picture counts only on a page with no other text.
 */

interface Ref {
  $ref: string;
}

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
  coord_origin?: string;
}

interface Node {
  self_ref: string;
  label?: string;
  content_layer?: string;
  children?: Ref[];
  captions?: Ref[];
  prov?: { page_no: number; bbox?: Box }[];
  text?: string;
  enumerated?: boolean;
  marker?: string;
  data?: { grid?: { text?: string }[][] };
}

/** A `DoclingDocument` as Docling's `export_to_dict` writes it: only the parts the pages read. */
export interface DoclingDocument {
  body: { children?: Ref[] };
  texts: unknown[];
  groups?: unknown[];
  tables?: unknown[];
  pictures?: unknown[];
  pages: Record<string, { page_no?: number; size?: { width: number; height: number } }>;
}

/** Under this many characters of other text, a page takes the text inside its pictures. */
export const pictureTextBelow = 20;
const maxHeadingLevel = 4;
/** At least this share of a document's headings must carry a section number to level them by it. */
const minNumberedShare = 0.3;
const sectionNumber = /^[\s#*]*(\d+(?:\.\d+)*)\.?\s+\S/;
const bareNumber = /^[-–—\s]*\d{1,4}[-–—\s]*$/;
/** A bare number this close to the top or bottom edge, as a share of the page's height, is a page number. */
const pageEdge = 0.1;

interface Block {
  page: number;
  markdown: string;
  chars: number;
  inPicture: boolean;
  list?: string;
}

const textOf = (node: Node) => (node.text ?? '').replace(/\s+/g, ' ').trim();

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
  (text ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');

const markdownTable = (grid: { text?: string }[][]) => {
  const rows = grid.map((row) => row.map((c) => cell(c.text)));
  const [header, ...rest] = rows;
  if (!header || rows.every((row) => row.every((c) => c === ''))) return undefined;
  const line = (row: string[]) => `| ${row.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rest.map(line)].join('\n');
};

export const doclingPages = (document: DoclingDocument): string[] => {
  const nodes = new Map<string, Node>();
  for (const list of [document.texts, document.groups, document.tables, document.pictures])
    for (const item of (list ?? []) as Node[]) nodes.set(item.self_ref, item);

  const pageCount = Math.max(
    0,
    ...Object.entries(document.pages).map(([key, page]) => page.page_no ?? Number(key)),
    ...[...nodes.values()].flatMap((n) => (n.prov ?? []).map((p) => p.page_no)),
  );
  const heightOf = (page: number) => document.pages[String(page)]?.size?.height;

  const inBody = (node: Node) => (node.content_layer ?? 'body') === 'body';

  const headings = [...nodes.values()].filter(
    (n) => n.label === 'section_header' && inBody(n) && textOf(n) !== '',
  );
  const numbered = headings.filter((n) => numberDepth(textOf(n)) !== undefined).length;
  const byNumber = headings.length > 0 && numbered / headings.length >= minNumberedShare;
  const headingLevel = (text: string) =>
    byNumber ? Math.min(numberDepth(text) ?? 1, maxHeadingLevel) : 1;

  /** A lone number at the page's top or bottom edge. */
  const isPageNumber = (node: Node, text: string) => {
    if (!bareNumber.test(text)) return false;
    const first = node.prov?.[0];
    const height = first && heightOf(first.page_no);
    if (!first?.bbox || !height) return false;
    const { t, b, coord_origin } = first.bbox;
    const [top, bottom] =
      coord_origin === 'TOPLEFT' ? [t, b] : [height - Math.max(t, b), height - Math.min(t, b)];
    return bottom < pageEdge * height || top > (1 - pageEdge) * height;
  };

  const blocks: Block[] = [];
  const firstPage = (node: Node): number | undefined => {
    const own = node.prov?.[0]?.page_no;
    if (own !== undefined) return own;
    for (const child of node.children ?? []) {
      const found = nodes.get(child.$ref);
      const page = found && firstPage(found);
      if (page !== undefined) return page;
    }
    return undefined;
  };

  interface Context {
    inPicture: boolean;
    list?: { ref: string; depth: number; ordered: boolean; counter: { n: number } };
  }

  const emit = (node: Node, markdown: string, chars: number, context: Context, list?: string) => {
    const page = firstPage(node);
    if (page === undefined) return;
    blocks.push({ page, markdown, chars, inPicture: context.inPicture, ...(list ? { list } : {}) });
  };

  const renderText = (node: Node, context: Context) => {
    const text = textOf(node);
    const label = node.label ?? 'text';
    if (label === 'page_header' || label === 'page_footer') return;
    if (text !== '' && !isPageNumber(node, text)) {
      if (label === 'title') emit(node, `# ${text}`, text.length, context);
      else if (label === 'section_header')
        emit(node, `${'#'.repeat(headingLevel(text))} ${text}`, text.length, context);
      else if (label === 'list_item' && context.list) {
        const { list } = context;
        list.counter.n += 1;
        const bullet = list.ordered ? `${list.counter.n}.` : '-';
        emit(node, `${'  '.repeat(list.depth)}${bullet} ${text}`, text.length, context, list.ref);
      } else if (label === 'list_item') emit(node, `- ${text}`, text.length, context);
      else if (label === 'code')
        emit(node, `\`\`\`\n${node.text ?? ''}\n\`\`\``, text.length, context);
      else if (label === 'checkbox_selected') emit(node, `- [x] ${text}`, text.length, context);
      else if (label === 'checkbox_unselected') emit(node, `- [ ] ${text}`, text.length, context);
      else emit(node, text, text.length, context);
    }
    visitChildren(node, context);
  };

  const renderGroup = (node: Node, context: Context) => {
    if (node.label === 'inline') {
      const parts = (node.children ?? [])
        .map((c) => nodes.get(c.$ref))
        .filter((n): n is Node => n !== undefined && inBody(n))
        .map(textOf)
        .filter((t) => t !== '');
      const text = parts.join(' ');
      if (text !== '') emit(node, text, text.length, context, context.list?.ref);
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

  const renderTable = (node: Node, context: Context) => {
    const captions = new Set((node.captions ?? []).map((c) => c.$ref));
    for (const ref of captions) visit(ref, context);
    const table = node.data?.grid && markdownTable(node.data.grid);
    if (table) {
      const chars = (node.data?.grid ?? []).flat().reduce((sum, c) => sum + cell(c.text).length, 0);
      emit(node, table, chars, context);
    }
    for (const child of node.children ?? [])
      if (!captions.has(child.$ref)) visit(child.$ref, context);
  };

  const renderPicture = (node: Node, context: Context) => {
    const captions = new Set((node.captions ?? []).map((c) => c.$ref));
    for (const ref of captions) visit(ref, context);
    for (const child of node.children ?? [])
      if (!captions.has(child.$ref)) visit(child.$ref, { inPicture: true });
  };

  const visitChildren = (node: Node, context: Context) => {
    for (const child of node.children ?? []) visit(child.$ref, context);
  };

  const visit = (ref: string, context: Context) => {
    const node = nodes.get(ref);
    if (!node || !inBody(node)) return;
    if (ref.startsWith('#/texts/')) renderText(node, context);
    else if (ref.startsWith('#/tables/')) renderTable(node, context);
    else if (ref.startsWith('#/pictures/')) renderPicture(node, context);
    else renderGroup(node, context);
  };

  for (const child of document.body.children ?? []) visit(child.$ref, { inPicture: false });

  const pages: Block[][] = Array.from({ length: pageCount }, () => []);
  for (const block of blocks) pages[block.page - 1]?.push(block);
  return pages.map((page) => {
    const other = page.filter((b) => !b.inPicture).reduce((sum, b) => sum + b.chars, 0);
    const kept = other < pictureTextBelow ? page : page.filter((b) => !b.inPicture);
    return kept.reduce((markdown, block, i) => {
      if (i === 0) return block.markdown;
      const previous = kept[i - 1];
      const sameList = block.list !== undefined && block.list === previous?.list;
      return `${markdown}${sameList ? '\n' : '\n\n'}${block.markdown}`;
    }, '');
  });
};
