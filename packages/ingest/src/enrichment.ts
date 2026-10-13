import type { DatasetConfig, SearchRequest, SearchResult } from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import { shortHash } from '@genai/valuehash';

export const hypotheticalQuestionsSystemPrompt =
  'You generate hypothetical search questions from passages of text. Reply only with the questions, one per line.';

export const defaultQuestionPrompt =
  'Du leser et utdrag fra et offentlig dokument og skal foreslå ' +
  '{{question-count}} hypotetiske spørsmål som dette utdraget besvarer ' +
  'direkte. Spørsmålene skal:\n' +
  '- være på samme språk som utdraget (vanligvis norsk),\n' +
  '- være konkrete og søkbare (egne navn, datoer, tall der det er relevant),\n' +
  '- ikke gjenta hverandre,\n' +
  '- kunne besvares fullt ut av innholdet i utdraget alene.\n' +
  '\n' +
  'Dokumenttittel: {{doc-title}}\n' +
  'Dokument-URL: {{doc-url}}\n' +
  '\n' +
  '<utdrag>\n' +
  '{{chunk-content}}\n' +
  '</utdrag>\n' +
  '\n' +
  'Skriv ett spørsmål per linje. Ingen nummerering. Ingen punktmerker. ' +
  'Ingen tekst før eller etter spørsmålene.';

export const agentComposedModel = 'agent-composed';

export interface QuestionPromptInput {
  questionCount?: number;
  title?: string;
  url?: string;
  content?: string;
}

export const renderQuestionPrompt = (template: string, input: QuestionPromptInput) =>
  template
    .replaceAll('{{question-count}}', String(input.questionCount ?? 4))
    .replaceAll('{{doc-title}}', input.title ?? '')
    .replaceAll('{{doc-url}}', input.url ?? '')
    .replaceAll('{{chunk-content}}', input.content ?? '');

const listMarker = /^[ \t\n\v\f\r]*(?:[-•*][ \t\n\v\f\r]+|\(?\d+[.)][ \t\n\v\f\r]+)/;

export const parseQuestions = (content: string | null | undefined): string[] => [
  ...new Set(
    (content ?? '')
      .split(/\r?\n/)
      .map((line) => line.replace(listMarker, '').trim())
      .filter((line) => line !== ''),
  ),
];

export interface ChunkToEnrich {
  chunkId: string;
  docNum?: string | undefined;
  content: string;
  title?: string | undefined;
  url?: string | undefined;
}

export interface QuestionProvenance {
  model?: string;
  promptHash?: string;
  generatedAtMs?: number;
  questionCount?: number;
}

export interface QuestionProposal {
  chunkId: string;
  docNum?: string;
  questions: string[];
  provenance?: QuestionProvenance;
}

export interface ProposeOptions {
  questionCount?: number;
  temperature?: number;
  template?: string;
  now?: () => number;
}

export const proposeQuestions = async (
  model: ModelPort,
  chunk: ChunkToEnrich,
  options: ProposeOptions = {},
): Promise<QuestionProposal> => {
  const count = options.questionCount ?? 4;
  const prompt = renderQuestionPrompt(options.template ?? defaultQuestionPrompt, {
    questionCount: count,
    content: chunk.content,
    ...(chunk.title === undefined ? {} : { title: chunk.title }),
    ...(chunk.url === undefined ? {} : { url: chunk.url }),
  });
  const result = await model.chat({
    messages: [
      { role: 'system', content: hypotheticalQuestionsSystemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature: options.temperature ?? 0.4,
  });
  const questions = parseQuestions(result.content).slice(0, count);
  return {
    chunkId: chunk.chunkId,
    ...(chunk.docNum === undefined ? {} : { docNum: chunk.docNum }),
    questions,
    provenance: {
      model: result.servedModel || model.info().id,
      promptHash: shortHash(prompt),
      generatedAtMs: (options.now ?? Date.now)(),
      questionCount: questions.length,
    },
  };
};

export interface EnrichmentRow {
  id: string;
  chunk_id: string;
  doc_num: string;
  question: string;
  model: string;
  generated_at: number;
  prompt_hash?: string;
}

export const questionRowId = (chunkId: string, question: string) =>
  shortHash(`${chunkId}|${question}`);

export const proposalsToRows = (
  proposals: QuestionProposal[],
  now: () => number = Date.now,
): EnrichmentRow[] =>
  proposals.flatMap((proposal) => {
    const model = proposal.provenance?.model ?? agentComposedModel;
    const generatedAt = proposal.provenance?.generatedAtMs ?? now();
    const promptHash = proposal.provenance?.promptHash;
    return proposal.questions
      .filter((q) => typeof q === 'string' && q !== '')
      .map((question) => ({
        id: questionRowId(proposal.chunkId, question),
        chunk_id: proposal.chunkId,
        doc_num: proposal.docNum ?? '',
        question,
        model,
        generated_at: generatedAt,
        ...(promptHash ? { prompt_hash: promptHash } : {}),
      }));
  });

export const proposedChunkIds = (proposals: QuestionProposal[]) => [
  ...new Set(proposals.map((p) => p.chunkId).filter((id) => id !== '')),
];

export interface EnrichmentWriter {
  replaceQuestions(
    dataset: DatasetConfig,
    rows: EnrichmentRow[],
    chunkIds: string[],
  ): Promise<number>;
  revertQuestions(dataset: DatasetConfig, chunkId: string, promptHash?: string): Promise<number>;
}

const isEnrichmentWriter = (value: unknown): value is EnrichmentWriter =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as EnrichmentWriter).replaceQuestions === 'function' &&
  typeof (value as EnrichmentWriter).revertQuestions === 'function';

export const enrichmentWriterOf = (writer: unknown): EnrichmentWriter | undefined => {
  const candidate =
    typeof writer === 'object' && writer !== null
      ? (writer as { enrichment?: unknown }).enrichment
      : undefined;
  return isEnrichmentWriter(candidate) ? candidate : undefined;
};

export const memoryEnrichmentWriter = () => {
  const rows = new Map<string, Map<string, EnrichmentRow>>();
  const of = (dataset: DatasetConfig) => {
    const found = rows.get(dataset.id) ?? new Map<string, EnrichmentRow>();
    rows.set(dataset.id, found);
    return found;
  };
  const writer: EnrichmentWriter & { rows(dataset: string): EnrichmentRow[] } = {
    replaceQuestions: async (dataset, next, chunkIds) => {
      const table = of(dataset);
      for (const [id, row] of table) if (chunkIds.includes(row.chunk_id)) table.delete(id);
      for (const row of next) table.set(row.id, row);
      return next.length;
    },
    revertQuestions: async (dataset, chunkId, promptHash) => {
      const table = of(dataset);
      let removed = 0;
      for (const [id, row] of table)
        if (row.chunk_id === chunkId && (!promptHash || row.prompt_hash === promptHash)) {
          table.delete(id);
          removed += 1;
        }
      return removed;
    },
    rows: (dataset) => [...(rows.get(dataset)?.values() ?? [])],
  };
  return writer;
};

export interface VerifyInput {
  chunkId?: string;
  query?: string;
  enrichmentProfile?: string;
  baselineProfile?: string;
  limit?: number;
  evalGatePass?: boolean;
}

export interface VerifyResult {
  baselineFound: boolean | null;
  baselineRank: number | null;
  baselineIndex: number | null;
  enrichedFound: boolean;
  enrichedRank: number | null;
  enrichedIndex: number | null;
  rankDelta: number | null;
  positionDelta: number | null;
  newlyFindable: boolean | null;
  matchedQuestion: string | null;
  improved: boolean | null;
  evalGatePass: boolean | null;
  keep: boolean;
  skipped?: string;
}

type Search = (request: SearchRequest) => Promise<SearchResult>;

const located = (result: SearchResult | undefined, chunkId: string) => {
  if (!result) return undefined;
  const index = result.hits.findIndex((h) => h.id === chunkId);
  const hit = result.hits[index];
  return hit ? { index, rank: hit.score, text: hit.text } : undefined;
};

export const verifyEnrichment = async (
  search: Search,
  input: VerifyInput,
): Promise<VerifyResult> => {
  const evalGatePass = input.evalGatePass ?? null;
  const skipped = !input.enrichmentProfile
    ? 'missing enrichment profile'
    : !input.query
      ? 'missing query'
      : !input.chunkId
        ? 'missing chunk id'
        : undefined;
  if (skipped || !input.enrichmentProfile || !input.query || !input.chunkId)
    return {
      baselineFound: null,
      baselineRank: null,
      baselineIndex: null,
      enrichedFound: false,
      enrichedRank: null,
      enrichedIndex: null,
      rankDelta: null,
      positionDelta: null,
      newlyFindable: null,
      matchedQuestion: null,
      improved: null,
      evalGatePass,
      keep: evalGatePass === true,
      skipped: skipped ?? 'missing input',
    };
  const limit = input.limit ?? 20;
  const baselineHits = input.baselineProfile
    ? await search({ query: input.query, profile: input.baselineProfile, limit })
    : undefined;
  const enrichedHits = await search({
    query: input.query,
    profile: input.enrichmentProfile,
    limit,
  });
  const baseline = located(baselineHits, input.chunkId);
  const enriched = located(enrichedHits, input.chunkId);
  const rankDelta = baseline && enriched ? enriched.rank - baseline.rank : null;
  const positionDelta = baseline && enriched ? baseline.index - enriched.index : null;
  const newlyFindable = baselineHits !== undefined && !baseline && enriched !== undefined;
  const improved =
    baselineHits === undefined
      ? enriched !== undefined
      : newlyFindable || (positionDelta !== null && positionDelta > 0);
  return {
    baselineFound: baselineHits === undefined ? null : baseline !== undefined,
    baselineRank: baseline?.rank ?? null,
    baselineIndex: baseline?.index ?? null,
    enrichedFound: enriched !== undefined,
    enrichedRank: enriched?.rank ?? null,
    enrichedIndex: enriched?.index ?? null,
    rankDelta,
    positionDelta,
    newlyFindable,
    matchedQuestion: enriched?.text || null,
    improved,
    evalGatePass,
    keep: improved && evalGatePass === true,
  };
};
