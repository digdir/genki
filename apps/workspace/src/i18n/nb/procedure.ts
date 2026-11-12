import { defineNamespace } from '@genai/i18n';

/** Titles for the steps the platform reports by tool name, as the approach card shows them. */
export const procedure = defineNamespace({
  plan_queries: 'Forsto spørsmålet',
  inspect_filters: 'Så på hvilke kilder tråden leser fra',
  search: 'Lette etter steder som handler om spørsmålet',
  read_chunks: 'Leste de relevante delene nøye',
  rerank_results: 'Valgte ut det som svarer på spørsmålet',
  report_gaps: 'Det jeg ikke fant',
  generate_response: 'Skrev svaret',
});
