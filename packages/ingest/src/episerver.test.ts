import { describe, expect, it } from 'vitest';
import { shortHash } from '@genai/valuehash';
import {
  episerverHtmlToMarkdown,
  episerverPages,
  episerverSource,
  filterEpiserverPages,
  parseXml,
  runIngest,
  type IndexSink,
} from './index.js';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const property = (name: string, value?: string) =>
  `<RawProperty><Name>${name}</Name>${
    value === undefined ? '<IsNull>true</IsNull>' : `<Value>${escape(value)}</Value>`
  }<Type>String</Type></RawProperty>`;

const page = (props: Record<string, string | undefined>) =>
  `<TransferContentData><RawContentData><Property>${Object.entries(props)
    .map(([k, v]) => property(k, v))
    .join('')}</Property></RawContentData></TransferContentData>`;

const base = {
  PageWorkStatus: '4',
  PageDeleted: 'False',
  PageLanguageBranch: 'no',
  PageTypeName: 'ArticlePage',
};

const exportXml = (pages: Record<string, string | undefined>[]) =>
  `\uFEFF<?xml version="1.0" encoding="utf-8"?><exportPackage><pages>${pages
    .map(page)
    .join('')}</pages></exportPackage>`;

describe('EPiServer export', () => {
  it('reads published, undeleted pages in the chosen language and page types, then applies offset and limit', () => {
    const pages = episerverPages(
      exportXml([
        { ...base, PageName: 'A' },
        { ...base, PageName: 'Utkast', PageWorkStatus: '2' },
        { ...base, PageName: 'Slettet', PageDeleted: 'True' },
        { ...base, PageName: 'Engelsk', PageLanguageBranch: 'en' },
        { ...base, PageName: 'Nyhet', PageTypeName: 'NewsPage' },
        { ...base, PageName: 'B' },
        { ...base, PageName: 'C' },
      ]),
    );
    const names = (filter: Parameters<typeof filterEpiserverPages>[1]) =>
      filterEpiserverPages(pages, filter).map((p) => p.get('PageName')?.value);

    expect(names({ language: 'no' })).toEqual(['A', 'Nyhet', 'B', 'C']);
    expect(names({ language: 'no', pageTypes: ['ArticlePage'] })).toEqual(['A', 'B', 'C']);
    expect(names({ language: 'no', pageTypes: ['ArticlePage'], offset: 1, limit: 1 })).toEqual([
      'B',
    ]);
    expect(names({ language: 'en' })).toEqual(['Engelsk']);
  });

  it('parses CDATA, entities and self-closing elements in the export XML', () => {
    const root = parseXml('<a><b x="1>2"/><c><![CDATA[<p>hei</p>]]> &amp; &#248;</c></a>');
    expect(root.content[0]).toEqual({
      tag: 'a',
      content: [
        { tag: 'b', content: [] },
        { tag: 'c', content: ['<p>hei</p> & ø'] },
      ],
    });
  });

  it('converts EPiServer HTML to markdown with the headless-rag rules', () => {
    expect(
      episerverHtmlToMarkdown(
        '<h2 class="x">Frister</h2><p>Søk innen <strong>1. mars</strong> p&aring; <a href="/skjema">skjemaet</a>.</p><ul><li>én</li><li>to</li></ul>',
      ),
    ).toBe('## Frister\n\nSøk innen **1. mars** på [skjemaet](/skjema).\n\n- én\n- to');
  });

  it('stores a page with headless-rag fields: the id hashes the page GUID, the url is the URL segment and chunks carry the GUID', async () => {
    const guid = '7b1c0d2e-0000-4000-8000-000000000001';
    const pages = episerverPages(
      exportXml([
        {
          ...base,
          PageGUID: guid,
          PageName: 'Tilskudd',
          PageURLSegment: 'tilskudd',
          PageChanged: '2025-01-02T10:00:00',
          MetaDescription: 'Om tilskudd',
          Heading: '<h1>Tilskudd</h1>',
          MainIntro: '<p>Kort om ordningen.</p>',
          MainBody: '<h2>Hvem kan søke</h2><p>Kommuner og fylker kan søke om tilskudd.</p>',
        },
      ]),
    );
    const stored: { doc: Record<string, unknown>; chunks: Record<string, unknown>[] }[] = [];
    const sink: IndexSink = {
      ensureCollections: async () => undefined,
      storeDocument: async (_names, _docNum, doc, chunks) => void stored.push({ doc, chunks }),
    };

    const result = await runIngest({
      source: episerverSource({ pages, baseUrl: 'https://www.example.no' }),
      chunking: {
        strategy: { kind: 'header-based' },
        minimumLength: 10,
        maximumLength: 4000,
        metadataStyle: 'pr',
      },
      collections: { docs: 'd', chunks: 'c', phrases: 'p' },
      sink,
      done: new Set(),
    });

    expect(result).toMatchObject({ stored: 1, failed: [] });
    const id = shortHash(guid);
    expect(stored[0]?.doc).toEqual({
      id,
      doc_num: id,
      page_guid: guid,
      title: 'Tilskudd',
      url: 'https://www.example.no/tilskudd',
      url_segment: 'tilskudd',
      language: 'no',
      page_type: 'ArticlePage',
      lastmod: '2025-01-02T10:00:00',
      type: 'episerver',
      meta_keywords: '',
      meta_description: 'Om tilskudd',
      total_chunks: stored[0]?.chunks.length,
    });
    expect(stored[0]?.chunks.length).toBeGreaterThan(0);
    for (const chunk of stored[0]?.chunks ?? [])
      expect(chunk).toMatchObject({ doc_num: id, page_guid: guid, id: chunk.chunk_id });
  });
});
