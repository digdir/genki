import { describe, expect, it } from 'vitest';
import {
  byExtension,
  markerConverter,
  markerPageSeparator,
  markerRetryDelaysMs,
  type DocumentConverter,
} from './index.js';

const file = {
  name: 'rapport.pdf',
  bytes: new TextEncoder().encode('%PDF'),
  mimetype: 'application/pdf',
};

const marker = (statuses: number[], sleeps: number[], retryDelaysMs?: number[]) => {
  const calls: string[] = [];
  const converter = markerConverter({
    url: 'https://marker.example.no/convert',
    credential: { kind: 'api-key', key: async () => 'k' },
    sleep: async (ms) => void sleeps.push(ms),
    ...(retryDelaysMs ? { retryDelaysMs } : {}),
    fetch: (async (url: string | URL) => {
      calls.push(String(url));
      const status = statuses.shift() ?? 200;
      return status === 200
        ? Response.json({ success: true, pages: ['Side 1', 'Side 2'] })
        : Response.json({ success: false }, { status });
    }) as typeof fetch,
  });
  return { converter, calls };
};

describe('Marker conversion', () => {
  it('retries 429, 502 and 503 along the headless-rag ladder of 1, 10, 30, 60 and 120 minutes and 24 hours', async () => {
    const sleeps: number[] = [];
    const { converter, calls } = marker([429, 502, 503], sleeps);

    expect(await converter.toMarkdown(file)).toBe(`Side 1${markerPageSeparator}Side 2`);
    expect(sleeps).toEqual(markerRetryDelaysMs.slice(0, 3));
    expect(markerRetryDelaysMs).toEqual([
      60_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 86_400_000,
    ]);
    expect(calls[0]).toBe('https://marker.example.no/convert?cache=true');
  });

  it('gives up at once on other statuses and when the configured ladder is spent', async () => {
    const sleeps: number[] = [];
    await expect(marker([500], sleeps).converter.toMarkdown(file)).rejects.toThrow(/HTTP 500/);
    await expect(marker([503, 503], sleeps, [5]).converter.toMarkdown(file)).rejects.toThrow(
      /HTTP 503/,
    );
    expect(sleeps).toEqual([5]);
  });

  it('sends PDF files to Marker and other documents to the local converter', async () => {
    const seen: string[] = [];
    const named = (label: string): DocumentConverter => ({
      toMarkdown: async (f) => {
        seen.push(`${label}:${f.name}`);
        return label;
      },
    });
    const converter = byExtension([
      { converter: named('marker'), extensions: ['.pdf'] },
      { converter: named('local'), extensions: ['.docx'] },
    ]);

    await converter.toMarkdown(file);
    await converter.toMarkdown({ name: 'notat.docx', bytes: new Uint8Array() });
    await converter.toMarkdown({
      name: 'uten-endelse',
      bytes: new Uint8Array(),
      mimetype: 'application/pdf',
    });

    expect(seen).toEqual(['marker:rapport.pdf', 'local:notat.docx', 'marker:uten-endelse']);
    expect(converter.extensions).toEqual(['.pdf', '.docx']);
  });
});
