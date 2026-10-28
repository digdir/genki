import { describe, expect, it } from 'vitest';
import { markerConverter, markerPageSeparator } from './converter.js';
import { inMemoryConversionStore, storingConverter } from './stored-conversions.js';

const file = (content: string) => ({
  name: 'rapport.pdf',
  bytes: new TextEncoder().encode(content),
  mimetype: 'application/pdf',
});

// The Marker service's answer: pages, Marker's JSON and metadata, and what made them
const markerService = (version = '1.10.2') => {
  const calls: string[] = [];
  const converter = markerConverter({
    url: 'https://marker.example.no/convert',
    credential: { kind: 'api-key', key: async () => 'k' },
    fetch: (async (url: string | URL) => {
      calls.push(String(url));
      return Response.json({
        success: true,
        pages: ['\n\n{0}', '\n\nSide 1'],
        json: { block_type: 'Document', children: [{ block_type: 'Page', html: '<p>Side 1</p>' }] },
        metadata: { page_stats: [{ page_id: 0, text_extraction_method: 'pdftext' }] },
        marker_version: version,
        settings: { languages: 'no,en', paginate_output: true },
      });
    }) as typeof fetch,
  });
  return { converter, calls };
};

describe('stored conversions', () => {
  it('converts a file once and reads it from the store after that', async () => {
    const marker = markerService();
    const converter = storingConverter({
      store: inMemoryConversionStore(),
      converter: marker.converter,
      producer: 'marker',
    });

    const first = await converter.toMarkdown(file('%PDF-1'));
    const again = await converter.toMarkdown(file('%PDF-1'));

    expect(first).toBe(`\n\n{0}${markerPageSeparator}\n\nSide 1`);
    expect(again).toBe(first);
    expect(marker.calls).toHaveLength(1);
  });

  it('stores the version and settings Marker reports, with its pages, JSON and metadata', async () => {
    const store = inMemoryConversionStore();
    const converter = storingConverter({
      store,
      converter: markerService().converter,
      producer: 'marker',
    });

    await converter.toMarkdown(file('%PDF-1'));

    expect(store.all()).toEqual([
      {
        sha256: '21af8e71c8703196df7fe1ff901869a88fe64c07bbaa83d838efb45a52b4f303',
        producer: 'marker',
        version: '1.10.2',
        settings: { languages: 'no,en', paginate_output: true },
        markdown: `\n\n{0}${markerPageSeparator}\n\nSide 1`,
        output: {
          pages: ['\n\n{0}', '\n\nSide 1'],
          json: {
            block_type: 'Document',
            children: [{ block_type: 'Page', html: '<p>Side 1</p>' }],
          },
          metadata: { page_stats: [{ page_id: 0, text_extraction_method: 'pdftext' }] },
        },
      },
    ]);
  });

  it('converts again when asked to, and keeps each Marker version apart', async () => {
    const store = inMemoryConversionStore();
    const old = storingConverter({
      store,
      converter: markerService('1.10.2').converter,
      producer: 'marker',
    });
    const upgraded = markerService('1.11.0');

    await old.toMarkdown(file('%PDF-1'));
    await storingConverter({ store, converter: upgraded.converter, producer: 'marker' }).toMarkdown(
      file('%PDF-1'),
    );
    expect(upgraded.calls).toHaveLength(0);

    await storingConverter({
      store,
      converter: upgraded.converter,
      producer: 'marker',
      reconvert: true,
    }).toMarkdown(file('%PDF-1'));

    expect(upgraded.calls).toHaveLength(1);
    expect(store.all().map((c) => c.version)).toEqual(['1.10.2', '1.11.0']);
  });

  it('converts but stores nothing for a converter without raw output', async () => {
    const store = inMemoryConversionStore();
    const textLayer = { toMarkdown: async () => 'Tekst fra tekstlaget.' };

    const text = await storingConverter({
      store,
      converter: textLayer,
      producer: 'marker',
    }).toMarkdown(file('%PDF-2'));

    expect(text).toBe('Tekst fra tekstlaget.');
    expect(store.all()).toEqual([]);
  });
});
