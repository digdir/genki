import { untrustedData, type ToolSpec } from '@genai/port-model';
import { z } from 'zod';
import type { AgentRetrieval } from './workspace.js';

export const sourceFactsToolRef = 'source-facts@1';

export const isSourceFactsRef = (ref: string) => ref === sourceFactsToolRef;

export interface SourceFactsQuery {
  newest?: number;
  fields?: string[];
  maxValues?: number;
}

export interface SourceFactsReport {
  id: string;
  name?: string;
  inScope: boolean;
  documents?: number;
  lastImport?: string;
  newest: { id: string; title?: string; url?: string; date?: string; year?: string }[];
  newestOrder?: string;
  yearField?: string;
  filterValues: Record<string, { value: string; count: number }[]>;
}

export const sourceFactsTool: ToolSpec = {
  name: 'source_facts',
  description:
    'Facts about the document sources this service reads from, within the filters already applied: how many documents there are, when the source was last imported, the newest documents and the values each filter field has, with document counts. Use it for questions about the collection itself, such as how many documents there are, what is newest or which organisations and years it covers. It does not search the content.',
  parameters: {
    type: 'object',
    properties: {
      newest: {
        type: 'integer',
        description:
          'How many of the newest documents to list (default 10, at most 25, 0 for none)',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter fields to list values for; all listable fields when left out',
      },
      max_values: {
        type: 'integer',
        description: 'Values per field (default 20, at most 50)',
      },
    },
  },
};

const sourceFactsArgs = z.looseObject({
  newest: z.number().int().min(0).max(25).optional(),
  fields: z.array(z.string().min(1).max(100)).max(20).optional(),
  max_values: z.number().int().min(1).max(50).optional(),
});

const orderNotes: Record<string, string> = {
  'date-within-latest-years':
    'newest first by publication date, taken from the latest values of the year field',
  date: 'newest first by publication date among the first documents listed',
  'listing-order': 'the documents carry no date, so they are in the order the index lists them',
};

const reportOf = (fact: SourceFactsReport) => ({
  source: fact.name ?? fact.id,
  id: fact.id,
  in_scope: fact.inScope,
  documents: fact.documents ?? 'unknown',
  last_import: fact.lastImport ?? 'not recorded by the platform',
  ...(fact.yearField ? { year_field: fact.yearField } : {}),
  newest_documents: fact.newest,
  ...(fact.newestOrder ? { newest_order: orderNotes[fact.newestOrder] ?? fact.newestOrder } : {}),
  filter_values: fact.filterValues,
});

export const runSourceFacts = async (
  retrieval: AgentRetrieval,
  raw: unknown,
  signal: AbortSignal,
): Promise<{ content: string; ok: boolean }> => {
  const args = sourceFactsArgs.safeParse(raw ?? {});
  if (!args.success) return { content: 'Invalid source_facts arguments.', ok: false };
  if (!retrieval.sourceFacts)
    return { content: 'Error executing source_facts: the service has no source.', ok: false };
  try {
    const facts = await retrieval.sourceFacts(
      {
        ...(args.data.newest === undefined ? {} : { newest: args.data.newest }),
        ...(args.data.fields ? { fields: args.data.fields } : {}),
        ...(args.data.max_values === undefined ? {} : { maxValues: args.data.max_values }),
      },
      signal,
    );
    return {
      content: untrustedData('source-facts', JSON.stringify(facts.map(reportOf), null, 1)),
      ok: true,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      content: `Error executing source_facts: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
};
