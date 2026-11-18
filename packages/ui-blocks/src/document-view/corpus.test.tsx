// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import markerChunks from '../sources/fixtures/marker-chunks.json' with { type: 'json' };
import { scan } from '../sources/fixtures/signatures.js';
import { pairCitations, type SourceCitation } from '../sources/pairing.js';
import type { SourceDocument } from '../sources/types.js';
import { DocumentView } from './DocumentView.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

type Wire = Record<string, unknown>;
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

const sourceOf = (raw: Wire): SourceDocument => ({
  index: typeof raw.index === 'number' ? raw.index : undefined,
  title: str(raw.title) ?? '',
  url: str(raw.url),
  documentId: str(raw.document_id),
  publishedAt: str(raw.published_at),
  excerpts: ((raw.excerpts as Wire[] | undefined) ?? []).map((e) => ({
    chunkId: str(e.chunk_id) ?? '',
    text: str(e.text) ?? '',
    position: typeof e.position === 'number' ? e.position : undefined,
  })),
});

/** The answer's footnotes as a host reads them: by excerpt with `markers`, else by document. */
const citationsOf = (raw: Wire): SourceCitation[] => {
  const marks = [...(str(raw.answer) ?? '').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const markers = raw.markers as { marker: string; chunkId: string }[] | undefined;
  if (!markers) return marks.map((index) => ({ index }));
  const chunkOf = new Map(markers.map((m) => [Number(m.marker), m.chunkId]));
  return marks.flatMap((n) => {
    const chunkId = chunkOf.get(n);
    return chunkId ? [{ chunkId }] : [];
  });
};

interface Answer {
  file: string;
  sources: SourceDocument[];
  citations: SourceCitation[];
}

const marker: Answer = {
  file: 'fixtures/marker-chunks.json',
  citations: [],
  sources: markerChunks.documents.map((d, i): SourceDocument => ({
    index: i + 1,
    title: d.title,
    url: `https://example.org/${d.docNum}`,
    documentId: `kudos::${d.docNum}`,
    excerpts: [{ chunkId: `kudos::${d.chunk.id}`, text: d.chunk.contentMarkdown }],
  })),
};

// Captured answers, one JSON file each, as Sources' corpus test reads them.
const corpora = (process.env.GENAI_QA_CORPUS?.split(delimiter) ?? []).filter(existsSync);
const captured = corpora.flatMap((folder) =>
  readdirSync(folder)
    .filter((file) => /^q\d+.*\.json$/i.test(file))
    .map((file): Answer => {
      const raw = JSON.parse(readFileSync(join(folder, file), 'utf8')) as Wire;
      return {
        file: `${basename(folder)}/${file}`,
        sources: ((raw.sources as Wire[] | undefined) ?? []).map(sourceOf),
        citations: citationsOf(raw),
      };
    }),
);

const BLOCKS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'TABLE', 'TR', 'BLOCKQUOTE']);

const visible = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeName === 'BR') return '\n';
  const inner = [...node.childNodes].map(visible).join(node.nodeName === 'TR' ? '\t' : '');
  return BLOCKS.has(node.nodeName) ? `\n${inner}\n` : inner;
};

describe('the document view on real answers', () => {
  it('draws every excerpt of every document, a chip per cited excerpt, and no leftover from the source format', () => {
    const answers = [marker, ...captured];
    const leftovers: string[] = [];
    const counts: Record<string, number> = {};
    let documents = 0;
    let drawn = 0;
    let chips = 0;
    for (const { file, sources, citations } of answers) {
      const pairing = pairCitations(sources, citations);
      const cited =
        pairing.mode === 'excerpt'
          ? [...pairing.numbers.keys()].filter((chunk) =>
              sources.some((s) => s.excerpts.some((e) => e.chunkId === chunk)),
            ).length
          : 0;
      for (const source of sources) {
        const first = source.excerpts[0];
        if (!first) continue;
        render(
          <DocumentView
            sources={sources}
            target={{ chunkId: first.chunkId }}
            citations={citations}
            corpus="Kudos"
          />,
        );
        const view = screen.getByRole('region', { name: 'Dokumentvisning' });
        documents += 1;
        const passages = view.querySelectorAll('.uib-document-view-passage');
        expect(passages.length, `${file}: ${source.title}`).toBe(source.excerpts.length);
        drawn += passages.length;
        const row = within(view).queryByRole('group', { name: 'Utdrag i svaret:' });
        const shown = row ? within(row).getAllByRole('button').length : 0;
        expect(shown, `${file}: chips`).toBe(cited);
        chips += shown;
        const quotes = [...view.querySelectorAll('.uib-document-view-quote')];
        for (const element of quotes.flatMap((quote) => [...quote.querySelectorAll('a, sup, sub')]))
          leftovers.push(`${file} ${element.localName} «${element.textContent ?? ''}»`);
        for (const [name, found] of Object.entries(scan(visible(view)))) {
          counts[name] = (counts[name] ?? 0) + found.length;
          for (const hit of found) leftovers.push(`${file} ${name} «${hit.match}»: ${hit.context}`);
        }
        cleanup();
      }
    }
    console.info(
      `Drew ${documents} documents from ${answers.length} answers: ${drawn} excerpts, ${chips} chips; hits per signature ${JSON.stringify(counts)}`,
    );
    expect(drawn).toBeGreaterThan(0);
    expect(leftovers).toEqual([]);
  });
});
