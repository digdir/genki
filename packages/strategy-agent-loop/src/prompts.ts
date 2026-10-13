import type { ToolSpec } from '@genai/port-model';

export const defaultSystemPrompt = `You are a research assistant with access to a document knowledge base. Answer the user's question accurately.

Always include your reasoning in your message text before making tool calls. Explain what you're about to do and why.

Workflow — repeat as needed:
1. SEARCH: Use search with diverse queries. Returns metadata only — no content.
2. READ: Use read_chunks to fetch full content of promising results.
3. RERANK: Use rerank_results to surface the most relevant chunks in your workspace.
4. GENERATE: Use generate_response to produce an answer.

After each tool call, the system runs a sufficiency gate. If it rejects, follow the hint; if it passes, finalize.`;

export const agentTools: ToolSpec[] = [
  {
    name: 'search',
    description:
      'Search the document collection using multiple queries. Returns metadata-only results (chunk_id, doc_num, chunk_index, total_chunks, content_length, headers, scores) — NO content. Use read_chunks to fetch content of promising results.',
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Search queries to execute against the document collection',
        },
        filter_by: {
          type: 'object',
          description: 'Optional structured retrieval filter to constrain document search.',
          properties: {
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: {
                    type: 'string',
                    description:
                      'Document field to filter on (for example: owner_short, orgs_short, year, doc_num, title)',
                  },
                  selected_options: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Exact values to include',
                  },
                  value_type: {
                    type: 'string',
                    enum: ['string', 'integer'],
                    description: 'Filter value type. Defaults to string.',
                  },
                },
                required: ['field', 'selected_options'],
              },
            },
          },
        },
      },
      required: ['queries'],
    },
  },
  {
    name: 'read_chunks',
    description:
      'Read full content of specific chunks. Use after search to read promising results. Supports reading by chunk IDs or by document + chunk index range.',
    parameters: {
      type: 'object',
      properties: {
        chunk_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific chunk IDs to read',
        },
        doc_num: { type: 'string', description: 'Document number for range-based reading' },
        chunk_range: {
          type: 'object',
          properties: { from: { type: 'integer' }, to: { type: 'integer' } },
          description: 'Chunk index range within a document (requires doc_num)',
        },
        max_content_length: {
          type: 'integer',
          description: "Truncate each chunk's content to this many characters",
        },
      },
    },
  },
  {
    name: 'plan_queries',
    description:
      'Expand a question into multiple diverse search queries for better coverage. Use this before search_documents when the question is complex or multi-faceted.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question to expand into search queries' },
      },
      required: ['query'],
    },
  },
  {
    name: 'rerank_results',
    description:
      'Rerank the accumulated workspace chunks by relevance to a query. Use this after search_documents to get the most relevant results.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The query to rank relevance against' } },
      required: ['query'],
    },
  },
  {
    name: 'generate_response',
    description:
      'Generate a final response using the top-ranked context from the workspace. Use this after you have gathered and optionally reranked enough relevant context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question to answer using the gathered context' },
      },
      required: ['query'],
    },
  },
  {
    name: 'inspect_filters',
    description:
      'Inspect available filter fields for the docs collection, and optionally fetch top facet values for specific fields.',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional field names to inspect facet values for',
        },
        max_options: {
          type: 'integer',
          description: 'Maximum facet options per field (default 10)',
        },
      },
    },
  },
];

export const citationInstruction =
  'When making claims based on the provided sources, cite them using [N] notation where N is the source number. Every factual claim should have at least one citation. Place citations immediately after the relevant statement.';

export const ambiguityInstruction =
  'If the sources contain multiple plausible values, labels, or interpretations, do not hide the ambiguity. Compare the user’s wording to the source labels, preserve the source terminology, and explicitly mention ambiguity when the question is underspecified. Do not silently collapse distinct source labels into one concept. Do not merge or arithmetic-combine values from different labels, sentences, or chunks unless the source explicitly states that they belong together. If one label is clearly the closest semantic match, use it and state that label in the answer. If different chunks describe different scopes or definitions, explain that difference instead of producing a single blended number.';

export const sameLanguageRule =
  'Always respond in the SAME LANGUAGE as the user\'s question. If the question is Norwegian, answer in Norwegian. If English, answer in English. Do not mix languages (e.g. never produce phrases like "altinn date"). Preserve source-terminology verbatim even when writing in the other language.';

export const defaultGenerationPrompt =
  'Answer the question based on the context.\n\nContext:\n{context}\n\nQuestion: {question}';

const norwegianMonths = [
  'januar',
  'februar',
  'mars',
  'april',
  'mai',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'desember',
];

export const systemPromptWithDate = (now: Date): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Oslo',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = `${Number(parts.day)}. ${norwegianMonths[Number(parts.month) - 1]} ${parts.year}`;
  return `You are a helpful assistant. The date this conversation was created at is ${date} (Norwegian time).`;
};

export const exhaustionNudge =
  '[SYSTEM: You have used all available iterations. Based on everything you have gathered so far, provide your best answer now. If you found partial information, share it. Do not call any more tools.';

export const exhaustionDefault = 'Could not determine an answer within the iteration limit.';

export const noToolCallNudge =
  'You produced a response WITHOUT searching the knowledge base. You must answer ONLY from retrieved documents, never from prior knowledge — so you MUST search FIRST. Emit an actual search_documents tool call now; do not answer from memory and do not write the query as prose, pseudo-code, a `[SEARCH]` block, or `<tool_code>`.';

export const noToolCallHonestMiss =
  'Could not retrieve information from the knowledge base to answer this question.';

export const searchScaffold =
  /^\s*(\[SEARCH\]|SEARCH\s*[(:]|SEARCH\s+quer|<tool_code>|\d+\.\s+SEARCH\b|Query alternatives|print\s*\(\s*SEARCH|La meg søke)/im;

export interface ActiveFilter {
  field: string;
  type?: string;
  options: string[];
}

export const activeFiltersInstruction = (filters: ActiveFilter[]) =>
  `Active filters set by the caller: ${filters
    .map(
      (f) =>
        `${f.field} ${f.type === 'not-in-set' ? 'is none of' : 'is one of'} ${f.options.join(', ')}`,
    )
    .join(
      '; ',
    )}. Every search is already limited to them. Do not search outside them or try to widen or remove them with filter_by. If nothing within them answers the question, say so and finish. Cite sources as [N], never by chunk_id.`;
