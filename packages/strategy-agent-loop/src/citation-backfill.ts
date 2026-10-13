import { detectInsufficientContext, parseCitations, validateCitations } from './citations.js';
import { exhaustionDefault, noToolCallHonestMiss } from './prompts.js';
import { insufficientContextResponse, runBuiltinTool, type ToolEnvironment } from './tools.js';
import type { Chunk, Workspace } from './workspace.js';

export const backfillReadLimit = 5;

const refusalPatterns = [
  /(?<![\p{L}\p{N}])(fant|finner|funnet)\s+(jeg\s+)?(ikke|ingen)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(har|hadde)\s+(dessverre\s+)?ikke\s+(funnet|klart å finne|informasjon)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])ingen\s+(spesifikk|spesifikke|eksplisitt|direkte|konkret)\s+(informasjon|omtale|referanse|opplysning)/u,
  /(?<![\p{L}\p{N}])ikke\s+(har\s+)?(funnet|klart å finne|tilgang)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(kunne|kan) ikke finne(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])ser ikke ut til(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])ikke\s+(spesifikt\s+)?(nevnt|omtalt|oppgitt|spesifisert|tilgjengelig)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])men ikke spesifikt om(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(ikke inneholder|inneholder ikke|ikke relevante (resultater|treff))(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])umulig å (forutsi|si|svare|fastslå)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(dekker ikke|foreligger ikke)(?![\p{L}\p{N}])/u,
  /^ønsker du\b/u,
  /\b(could not|couldn't|did not|didn't) find\b/,
];

export const soundsLikeRefusal = (text: string): boolean => {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized === '') return true;
  if (text === exhaustionDefault || text === noToolCallHonestMiss) return true;
  return (
    detectInsufficientContext(normalized).insufficient ||
    refusalPatterns.some((p) => p.test(normalized))
  );
};

export type CitationSettlement =
  | { action: 'keep'; reason: string }
  | { action: 'carry-through' }
  | { action: 'backfill'; readFirst: string[]; refusal?: true };

const readPool = (workspace: Workspace): Chunk[] => {
  const read = workspace.readChunkIds();
  return workspace.contextDocs.length
    ? workspace.contextDocs
    : workspace.chunksForOutput().filter((c) => read.has(c.chunkId));
};

const backfillCandidates = (workspace: Workspace): Chunk[] =>
  readPool(workspace)
    .filter((c) => !workspace.nonSupporting.has(c.chunkId))
    .slice(0, 10);

const refusalBackfillCandidates = (workspace: Workspace): Chunk[] => {
  const pool = readPool(workspace);
  const supporting = (c: Chunk) => !workspace.nonSupporting.has(c.chunkId);
  return [...pool.filter(supporting), ...pool.filter((c) => !supporting(c))].slice(0, 10);
};

const unreadSearchHits = (workspace: Workspace) => {
  const read = workspace.readChunkIds();
  return [...new Set(workspace.searches.flatMap((s) => s.chunkIds))]
    .filter((id) => !read.has(id))
    .slice(0, backfillReadLimit);
};

export const settleCitations = (answer: string, workspace: Workspace): CitationSettlement => {
  if (validateCitations(answer, workspace.citationIndex).grounded)
    return { action: 'keep', reason: 'cited' };
  const refusal = soundsLikeRefusal(answer);
  const generated = workspace.lastGeneratedResponse;
  if (
    generated &&
    generated !== answer &&
    (refusal || !workspace.lastGenerateInsufficient) &&
    validateCitations(generated, workspace.citationIndex).grounded
  )
    return { action: 'carry-through' };
  if (workspace.citationIndex.size > 0) return { action: 'keep', reason: 'generated-uncited' };
  if (refusal)
    return refusalBackfillCandidates(workspace).length
      ? { action: 'backfill', readFirst: [], refusal: true }
      : { action: 'keep', reason: 'refusal' };
  const candidates = backfillCandidates(workspace);
  if (candidates.length) return { action: 'backfill', readFirst: [] };
  if (workspace.readChunkIds().size > 0) return { action: 'keep', reason: 'no-supporting-chunks' };
  const unread = unreadSearchHits(workspace);
  return unread.length
    ? { action: 'backfill', readFirst: unread }
    : { action: 'keep', reason: 'nothing-retrieved' };
};

export const backfillCitations = async (
  env: ToolEnvironment,
  readFirst: string[],
  refusal = false,
): Promise<string | undefined> => {
  const { workspace } = env;
  if (readFirst.length) {
    const chunks = await env.retrieval.read(readFirst, env.signal);
    if (chunks.length === 0) return undefined;
    workspace.recordRead({ chunkIds: chunks.map((c) => c.chunkId) }, chunks);
    workspace.addChunks(chunks);
  }
  const candidates = refusal ? refusalBackfillCandidates(workspace) : backfillCandidates(workspace);
  if (candidates.length === 0) return undefined;
  const previous = workspace.contextDocs;
  workspace.contextDocs = candidates;
  try {
    await runBuiltinTool('generate_response', env, { query: env.query });
  } finally {
    workspace.contextDocs = previous;
  }
  const text = workspace.lastGeneratedResponse;
  if (
    !text?.trim() ||
    insufficientContextResponse(text) ||
    !validateCitations(text, workspace.citationIndex).grounded
  ) {
    workspace.citations = [];
    return undefined;
  }
  return text;
};

export const citationsFor = (answer: string, workspace: Workspace) =>
  answer === workspace.lastGeneratedResponse
    ? workspace.citations
    : parseCitations(answer, workspace.citationIndex);
