import { shortHash } from '@genai/valuehash';
import type { Chunk } from './chunk-document.js';
import type { IngestSource, SourceDocument } from './pipeline.js';
import { clojureTrim } from './text.js';

export interface XmlElement {
  tag: string;
  content: (XmlElement | string)[];
}

const namedEntities: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return namedEntities[name] ?? whole;
  });

export const parseXml = (input: string): XmlElement => {
  const xml = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const root: XmlElement = { tag: '', content: [] };
  const stack: XmlElement[] = [root];
  const append = (node: XmlElement | string) => {
    const parent = stack[stack.length - 1] as XmlElement;
    const last = parent.content[parent.content.length - 1];
    if (typeof node === 'string' && typeof last === 'string')
      parent.content[parent.content.length - 1] = last + node;
    else parent.content.push(node);
  };
  let at = 0;
  while (at < xml.length) {
    const open = xml.indexOf('<', at);
    if (open < 0) {
      append(decodeEntities(xml.slice(at)));
      break;
    }
    if (open > at) append(decodeEntities(xml.slice(at, open)));
    if (xml.startsWith('<!--', open)) {
      at = xml.indexOf('-->', open) + 3;
    } else if (xml.startsWith('<![CDATA[', open)) {
      const end = xml.indexOf(']]>', open);
      append(xml.slice(open + 9, end));
      at = end + 3;
    } else if (xml.startsWith('<?', open)) {
      at = xml.indexOf('?>', open) + 2;
    } else if (xml.startsWith('<!', open)) {
      let depth = 0;
      let i = open + 2;
      for (; i < xml.length; i += 1) {
        if (xml[i] === '[') depth += 1;
        else if (xml[i] === ']') depth -= 1;
        else if (xml[i] === '>' && depth <= 0) break;
      }
      at = i + 1;
    } else if (xml[open + 1] === '/') {
      const end = xml.indexOf('>', open);
      const tag = xml.slice(open + 2, end).trim();
      const current = stack.pop();
      if (!current || current.tag !== tag)
        throw new Error(`The XML closes ${tag}, but ${current?.tag ?? 'nothing'} is open`);
      at = end + 1;
    } else {
      let i = open + 1;
      let quote: string | undefined;
      for (; i < xml.length; i += 1) {
        const c = xml[i];
        if (quote) {
          if (c === quote) quote = undefined;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      const body = xml.slice(open + 1, i);
      const selfClosing = body.endsWith('/');
      const tag = (body.match(/^[^\s/>]+/) ?? [''])[0];
      const element: XmlElement = { tag, content: [] };
      append(element);
      if (!selfClosing) stack.push(element);
      at = i + 1;
    }
    if (at <= 0) throw new Error('The XML has an unterminated comment, CDATA or declaration');
  }
  if (stack.length !== 1) throw new Error(`The XML ends inside ${stack[stack.length - 1]?.tag}`);
  return root;
};

const elements = (node: XmlElement, tag: string) =>
  node.content.filter((c): c is XmlElement => typeof c !== 'string' && c.tag === tag);

const firstText = (node: XmlElement | undefined) => {
  const first = node?.content[0];
  return typeof first === 'string' && first !== '' ? first : undefined;
};

export interface EpiserverProperty {
  name?: string;
  value?: string;
  type?: string;
  isNull?: string;
}

export type EpiserverPage = Map<string | undefined, EpiserverProperty>;

export const episerverPages = (xml: string): EpiserverPage[] => {
  const document = parseXml(xml);
  const top = document.content.find((c): c is XmlElement => typeof c !== 'string');
  const pages = top ? elements(top, 'pages')[0] : undefined;
  if (!pages) return [];
  return elements(pages, 'TransferContentData').map((page) => {
    const raw = elements(page, 'RawContentData')[0];
    const property = raw ? elements(raw, 'Property')[0] : undefined;
    const props: EpiserverPage = new Map();
    for (const rawProperty of property ? elements(property, 'RawProperty') : []) {
      const text = (tag: string) => firstText(elements(rawProperty, tag)[0]);
      const parsed: EpiserverProperty = {};
      const name = text('Name');
      const value = text('Value');
      const type = text('Type');
      const isNull = text('IsNull');
      if (name !== undefined) parsed.name = name;
      if (value !== undefined) parsed.value = value;
      if (type !== undefined) parsed.type = type;
      if (isNull !== undefined) parsed.isNull = isNull;
      props.set(name, parsed);
    }
    return props;
  });
};

const valueOf = (page: EpiserverPage, name: string) => page.get(name)?.value;

export interface EpiserverFilter {
  language: string;
  pageTypes?: string[];
  offset?: number;
  limit?: number;
}

export const filterEpiserverPages = (pages: EpiserverPage[], filter: EpiserverFilter) => {
  const types = new Set(filter.pageTypes ?? []);
  const kept = pages
    .filter((p) => valueOf(p, 'PageWorkStatus') === '4')
    .filter((p) => valueOf(p, 'PageDeleted') === 'False')
    .filter((p) => valueOf(p, 'PageLanguageBranch') === filter.language)
    .filter((p) => types.size === 0 || types.has(valueOf(p, 'PageTypeName') as string));
  const offset = filter.offset ?? 0;
  return kept.slice(offset, filter.limit === undefined ? undefined : offset + filter.limit);
};

const ws = '[ \\t\\n\\x0B\\f\\r]';

const entityReplacements: [RegExp, string][] = [
  [/&nbsp;/g, ' '],
  [/&amp;/g, '&'],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&oslash;/g, 'ø'],
  [/&aring;/g, 'å'],
  [/&aelig;/g, 'æ'],
  [/&Oslash;/g, 'Ø'],
  [/&Aring;/g, 'Å'],
  [/&AElig;/g, 'Æ'],
];

const markdownReplacements: [RegExp, string][] = [
  [/<h1[^>]*>(.*?)<\/h1>/g, '# $1\n\n'],
  [/<h2[^>]*>(.*?)<\/h2>/g, '## $1\n\n'],
  [/<h3[^>]*>(.*?)<\/h3>/g, '### $1\n\n'],
  [/<h4[^>]*>(.*?)<\/h4>/g, '#### $1\n\n'],
  [/<h5[^>]*>(.*?)<\/h5>/g, '##### $1\n\n'],
  [/<h6[^>]*>(.*?)<\/h6>/g, '###### $1\n\n'],
  [/<li[^>]*>(.*?)<\/li>/g, '- $1\n'],
  [/<ul[^>]*>/g, '\n'],
  [/<\/ul>/g, '\n'],
  [/<ol[^>]*>/g, '\n'],
  [/<\/ol>/g, '\n'],
  [/<p[^>]*>(.*?)<\/p>/g, '$1\n\n'],
  [/<strong[^>]*>(.*?)<\/strong>/g, '**$1**'],
  [/<b[^>]*>(.*?)<\/b>/g, '**$1**'],
  [/<em[^>]*>(.*?)<\/em>/g, '*$1*'],
  [/<i[^>]*>(.*?)<\/i>/g, '*$1*'],
  [/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/g, '[$2]($1)'],
  [new RegExp(`<br${ws}*/?>`, 'g'), '\n'],
  [/<div[^>]*>/g, '\n'],
  [/<\/div>/g, '\n'],
  [/<div[^>]*data-contentguid[^>]*>.*?<\/div>/g, ''],
  ...entityReplacements,
  [/&ndash;/g, '–'],
  [/&mdash;/g, '—'],
  [/<[^>]*>/g, ''],
  [/\n\n\n+/g, '\n\n'],
];

export const episerverHtmlToMarkdown = (html: string) =>
  clojureTrim(markdownReplacements.reduce((text, [re, to]) => text.replace(re, to), html));

export const mergeEpiserverContent = (page: EpiserverPage) =>
  [valueOf(page, 'Heading'), valueOf(page, 'MainIntro'), valueOf(page, 'MainBody')]
    .filter((part): part is string => part !== undefined)
    .map(episerverHtmlToMarkdown)
    .join('\n\n');

export const episerverPageToDoc = (page: EpiserverPage) => {
  const guid = valueOf(page, 'PageGUID');
  const segment = valueOf(page, 'PageURLSegment');
  const id = shortHash(guid ?? null);
  return {
    id,
    doc_num: id,
    page_guid: guid ?? null,
    title: valueOf(page, 'PageName') ?? 'Untitled',
    url: segment ? `/${segment}` : '/unknown',
    url_segment: segment ?? '',
    language: valueOf(page, 'PageLanguageBranch') ?? 'no',
    page_type: valueOf(page, 'PageTypeName') ?? 'Unknown',
    lastmod: valueOf(page, 'PageChanged') ?? valueOf(page, 'PageSaved') ?? null,
    type: 'episerver',
    content_markdown: mergeEpiserverContent(page),
    meta_keywords: valueOf(page, 'MetaKeywords') ?? '',
    meta_description: valueOf(page, 'MetaDescription') ?? '',
  };
};

export type EpiserverDoc = ReturnType<typeof episerverPageToDoc>;

const docFields = [
  'id',
  'doc_num',
  'page_guid',
  'title',
  'url',
  'url_segment',
  'language',
  'page_type',
  'lastmod',
  'type',
  'meta_keywords',
  'meta_description',
  'total_chunks',
] as const;

const chunkFields = [
  'chunk_id',
  'doc_num',
  'chunk_index',
  'content_markdown',
  'content_length',
  'metadata',
  'page_guid',
] as const;

const pick = (record: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.flatMap((k) => (k in record ? [[k, record[k]]] : [])));

export const prepareEpiserverDoc = (doc: EpiserverDoc, totalChunks: number, baseUrl?: string) =>
  pick(
    {
      ...doc,
      total_chunks: totalChunks,
      ...(baseUrl ? { url: `${baseUrl.replace(/\/+$/, '')}${doc.url}` } : {}),
    },
    docFields,
  );

export const prepareEpiserverChunks = (chunks: Chunk[]) =>
  chunks.map((c) => ({
    ...pick(c as unknown as Record<string, unknown>, chunkFields),
    id: c.chunk_id,
  }));

export interface EpiserverSourceOptions {
  pages: EpiserverPage[];
  baseUrl?: string;
}

export const episerverSource = (options: EpiserverSourceOptions): IngestSource => ({
  kind: 'episerver',
  phraseRows: 'pipeline',
  documents: async function* () {
    for (const page of options.pages) {
      const doc = episerverPageToDoc(page);
      const document: SourceDocument = {
        key: doc.id,
        docNum: doc.doc_num,
        name: doc.title,
        texts: [doc.content_markdown],
        ...(doc.page_guid ? { location: { key: 'page_guid', value: doc.page_guid } } : {}),
        stored: (chunks: Chunk[]) => prepareEpiserverDoc(doc, chunks.length, options.baseUrl),
        storedChunks: (chunks: Chunk[]) => prepareEpiserverChunks(chunks),
      };
      yield document;
    }
  },
});
