import type { Translation } from '@genai/i18n';
import type { procedure as source } from '../nb/procedure';

export const procedure = {
  plan_queries: 'Understood the question',
  inspect_filters: 'Looked at which sources the thread reads from',
  search: 'Looked for passages about the question',
  read_chunks: 'Read the relevant parts closely',
  rerank_results: 'Picked what answers the question',
  report_gaps: 'What I did not find',
  generate_response: 'Wrote the answer',
} satisfies Translation<typeof source>;
