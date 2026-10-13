import { describe, expect, it } from 'vitest';
import type { SearchRequest, SearchResult } from '@genai/port-knowledge';
import type { ChatRequest, ModelPort } from '@genai/port-model';
import { shortHash } from '@genai/valuehash';
import {
  defaultQuestionPrompt,
  enrichmentWriterOf,
  memoryEnrichmentWriter,
  parseQuestions,
  proposalsToRows,
  proposeQuestions,
  questionRowId,
  renderQuestionPrompt,
  verifyEnrichment,
} from './enrichment.js';

const fakeModel = (content: string, seen: ChatRequest[] = []): ModelPort => ({
  info: () => ({ id: 'test-model', residency: 'norway', capabilities: [] }),
  chat: async (request) => {
    seen.push(request);
    return {
      content,
      toolCalls: [],
      finishReason: 'stop',
      usage: {},
      servedModel: 'served-model',
    };
  },
  chatStream: async function* () {
    yield* [];
  },
});

const dataset = {
  id: '991825827/kudos',
  filters: {},
  options: { endpoint: 'local', residency: 'norway' },
};

describe('hypothetical question proposals', () => {
  it('strips list markers, trims, drops blank lines and duplicates like headless-rag', () => {
    expect(
      parseQuestions(
        '1. Hva er fristen?\n- Hvem søker?\n\n  (2) Hva koster det?\n• Hvem søker?\n* Når?\n',
      ),
    ).toEqual(['Hva er fristen?', 'Hvem søker?', 'Hva koster det?', 'Når?']);
  });

  it('fills the Norwegian template with count, title, url and chunk text', () => {
    const prompt = renderQuestionPrompt(defaultQuestionPrompt, {
      questionCount: 3,
      title: 'Tildelingsbrev',
      content: 'Fristen er 1. mars.',
    });
    expect(prompt).toContain('foreslå 3 hypotetiske spørsmål');
    expect(prompt).toContain('Dokumenttittel: Tildelingsbrev\nDokument-URL: \n');
    expect(prompt).toContain('<utdrag>\nFristen er 1. mars.\n</utdrag>');
  });

  it('caps questions at the count and stamps the served model and the hash of the rendered prompt', async () => {
    const seen: ChatRequest[] = [];
    const proposal = await proposeQuestions(
      fakeModel('Spørsmål en?\nSpørsmål to?\nSpørsmål tre?', seen),
      { chunkId: 'c1', docNum: 'd1', content: 'Tekst' },
      { questionCount: 2, now: () => 1000 },
    );
    const prompt = seen[0]?.messages[1]?.content as string;
    expect(proposal).toEqual({
      chunkId: 'c1',
      docNum: 'd1',
      questions: ['Spørsmål en?', 'Spørsmål to?'],
      provenance: {
        model: 'served-model',
        promptHash: shortHash(prompt),
        generatedAtMs: 1000,
        questionCount: 2,
      },
    });
    expect(seen[0]?.temperature).toBe(0.4);
    expect(seen[0]?.messages[0]?.role).toBe('system');
  });
});

describe('applying and reverting questions', () => {
  it('marks proposals without provenance as agent-composed and skips blank questions', () => {
    expect(proposalsToRows([{ chunkId: 'c1', questions: ['Hva?', ''] }], () => 7)).toEqual([
      {
        id: questionRowId('c1', 'Hva?'),
        chunk_id: 'c1',
        doc_num: '',
        question: 'Hva?',
        model: 'agent-composed',
        generated_at: 7,
      },
    ]);
  });

  it('replaces the earlier rows of a chunk on apply and reverts only the rows of one prompt hash', async () => {
    const writer = memoryEnrichmentWriter();
    const rows = (hash: string, questions: string[]) =>
      proposalsToRows([
        {
          chunkId: 'c1',
          questions,
          provenance: { model: 'm', promptHash: hash, generatedAtMs: 1 },
        },
      ]);
    await writer.replaceQuestions(dataset, rows('a', ['Gammel?']), ['c1']);
    await writer.replaceQuestions(dataset, rows('b', ['Ny?']), ['c1']);
    expect(writer.rows(dataset.id).map((r) => r.question)).toEqual(['Ny?']);
    expect(await writer.revertQuestions(dataset, 'c1', 'a')).toBe(0);
    expect(await writer.revertQuestions(dataset, 'c1', 'b')).toBe(1);
  });

  it('finds an enrichment store only on a writer that carries one', () => {
    const enrichment = memoryEnrichmentWriter();
    expect(enrichmentWriterOf({ enrichment })).toBe(enrichment);
    expect(enrichmentWriterOf({})).toBeUndefined();
    expect(enrichmentWriterOf(undefined)).toBeUndefined();
  });
});

describe('verifying an enrichment', () => {
  const searchWith =
    (lists: Record<string, string[]>) =>
    async (request: SearchRequest): Promise<SearchResult> => ({
      hits: (lists[request.profile ?? ''] ?? []).map((id, i) => ({
        id,
        score: 10 - i,
        text: `spørsmål for ${id}`,
        fields: {},
      })),
    });

  it('keeps a chunk that the enrichment made newly findable only when the eval gate passed', async () => {
    const search = searchWith({ content: ['x', 'y'], questions: ['c1'] });
    const input = {
      chunkId: 'c1',
      query: 'frist',
      enrichmentProfile: 'questions',
      baselineProfile: 'content',
    };
    expect(await verifyEnrichment(search, { ...input, evalGatePass: true })).toMatchObject({
      baselineFound: false,
      enrichedFound: true,
      enrichedIndex: 0,
      newlyFindable: true,
      improved: true,
      matchedQuestion: 'spørsmål for c1',
      keep: true,
    });
    expect(await verifyEnrichment(search, input)).toMatchObject({ improved: true, keep: false });
  });

  it('counts a chunk as improved only when it moved up the list', async () => {
    const input = {
      chunkId: 'c1',
      query: 'frist',
      enrichmentProfile: 'questions',
      baselineProfile: 'content',
      evalGatePass: true,
    };
    expect(
      await verifyEnrichment(searchWith({ content: ['x', 'c1'], questions: ['c1'] }), input),
    ).toMatchObject({ positionDelta: 1, rankDelta: 1, improved: true, keep: true });
    expect(
      await verifyEnrichment(searchWith({ content: ['c1'], questions: ['x', 'c1'] }), input),
    ).toMatchObject({ positionDelta: -1, improved: false, keep: false });
  });

  it('treats any enriched hit as an improvement when no baseline profile is given', async () => {
    expect(
      await verifyEnrichment(searchWith({ questions: ['c1'] }), {
        chunkId: 'c1',
        query: 'frist',
        enrichmentProfile: 'questions',
      }),
    ).toMatchObject({ baselineFound: null, newlyFindable: false, improved: true });
  });

  it('falls back to the eval gate alone when the query is missing', async () => {
    expect(
      await verifyEnrichment(searchWith({}), {
        chunkId: 'c1',
        enrichmentProfile: 'questions',
        evalGatePass: true,
      }),
    ).toMatchObject({ skipped: 'missing query', improved: null, keep: true });
  });
});
