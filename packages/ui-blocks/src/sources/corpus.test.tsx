// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { excerptMarkdown } from './excerptMarkdown.js';
import markerChunks from './fixtures/marker-chunks.json' with { type: 'json' };
import { scan } from './fixtures/signatures.js';
import { Sources } from './Sources.js';
import type { SourceDocument } from './types.js';

afterEach(cleanup);

type Wire = Record<string, unknown>;
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

const sourceOf = (raw: Wire): SourceDocument => ({
  index: typeof raw.index === 'number' ? raw.index : undefined,
  title: str(raw.title) ?? '',
  url: str(raw.url),
  documentId: str(raw.document_id),
  excerpts: ((raw.excerpts as Wire[] | undefined) ?? []).map((e) => ({
    chunkId: str(e.chunk_id) ?? '',
    text: str(e.text) ?? '',
    position: typeof e.position === 'number' ? e.position : undefined,
  })),
  excerpt: str(raw.excerpt),
});

const marker = {
  file: 'fixtures/marker-chunks.json',
  sources: markerChunks.documents.map((d, i): SourceDocument => ({
    index: i + 1,
    title: d.title,
    url: `https://example.org/${d.docNum}`,
    documentId: `kudos::${d.docNum}`,
    excerpts: [{ chunkId: `kudos::${d.chunk.id}`, text: d.chunk.contentMarkdown }],
  })),
};

// Captured answers from a test environment, one JSON file each with the stream's `sources`.
const corpora = (process.env.GENAI_QA_CORPUS?.split(delimiter) ?? []).filter(existsSync);
const captured = corpora.flatMap((folder) =>
  readdirSync(folder)
    .filter((file) => /^q\d+.*\.json$/i.test(file))
    .map((file) => ({
      file: `${basename(folder)}/${file}`,
      sources: (
        ((JSON.parse(readFileSync(join(folder, file), 'utf8')) as Wire).sources as Wire[]) ?? []
      ).map(sourceOf),
    })),
);

const BLOCKS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'TABLE', 'TR', 'BLOCKQUOTE']);

const visible = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeName === 'BR') return '\n';
  const inner = [...node.childNodes].map(visible).join(node.nodeName === 'TR' ? '\t' : '');
  return BLOCKS.has(node.nodeName) ? `\n${inner}\n` : inner;
};

describe('Sources on real excerpts', () => {
  it('draws every excerpt it is given, and none shows a leftover from the source format', () => {
    const answers = [marker, ...captured];
    const leftovers: string[] = [];
    const counts: Record<string, number> = {};
    let drawn = 0;
    let documentLinks = 0;
    for (const { file, sources } of answers) {
      if (!sources.length) continue;
      render(<Sources sources={sources} corpus="Kudos" />);
      const cards = [...screen.getByRole('list', { name: 'Kilder' }).children];
      sources.forEach((source, i) => {
        const card = cards[i];
        expect(
          card?.querySelectorAll('.uib-sources-excerpt').length,
          `${file}: ${source.title}`,
        ).toBe(source.excerpts.length || (excerptMarkdown(source.excerpt ?? '') ? 1 : 0));
        const quotes = [...(card?.querySelectorAll('.uib-sources-quote') ?? [])];
        drawn += quotes.length;
        for (const element of quotes.flatMap((quote) => [...quote.querySelectorAll('a, sup, sub')]))
          leftovers.push(`${file} ${element.localName} «${element.textContent ?? ''}»`);
        documentLinks += card?.querySelectorAll('.uib-sources-document-body > a').length ?? 0;
        for (const [name, found] of Object.entries(scan(card ? visible(card) : ''))) {
          counts[name] = (counts[name] ?? 0) + found.length;
          for (const hit of found) leftovers.push(`${file} ${name} «${hit.match}»: ${hit.context}`);
        }
      });
      cleanup();
    }
    console.info(
      `Scanned ${answers.length} answers, ${drawn} excerpts; hits per signature ${JSON.stringify(counts)}`,
    );
    expect(drawn).toBeGreaterThan(0);
    expect(documentLinks).toBeGreaterThan(0);
    expect(leftovers).toEqual([]);
  });

  it('finds the leftovers in the raw chunks, so a clean scan means something', () => {
    const raw = markerChunks.documents.map((d) => d.chunk.contentMarkdown).join('\n');
    const found = Object.values(scan(raw)).reduce((sum, hits) => sum + hits.length, 0);
    expect(found).toBeGreaterThan(0);
  });
});
