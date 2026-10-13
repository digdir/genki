import type { Translation } from '@genai/i18n';
import type { platformBlocks as source } from '../nb/platform-blocks.js';

export const platformBlocks = {
  flowAgentRagName: 'Agentic RAG',
  flowAgentRagDescription: 'General-purpose agentic retrieval assistant',
  flowAiOverviewName: 'AI Overview',
  flowAiOverviewDescription:
    'Short synthesised answer with inline chunk-level citations, ahead of the underlying results. Declines rather than answering on thin retrieval.',
  flowAltinnDocsTunedName: 'Altinn docs, tuned',
  flowAltinnDocsTunedDescription:
    'Retrieval tuned for the Altinn documentation, with phrase-only weights and per-strategy limits. An alternative you choose yourself instead of the general-purpose agent.',
  flowBasicRagName: 'Basic RAG',
  flowBasicRagDescription:
    'Plan queries, retrieve, rerank and answer from the numbered sources with citations',
  flowDocsOutlineName: 'Documentation outline',
  flowDocsOutlineDescription:
    'Propose a structured outline for a new documentation page from the existing docs it should build on',
  flowDocsReleaseCrossCheckName: 'Release notes cross-check',
  flowDocsReleaseCrossCheckDescription:
    'Turn release notes into a per-page to-do list of documentation edits, citing the pages that need them',
  flowEntityExtractionName: 'Entity extraction',
  flowEntityExtractionDescription:
    'Extract structured entities (people, organisations, dates, places and more) from text',
  flowFactCheckerName: 'Fact check',
  flowFactCheckerDescription: 'Verify claims against document evidence',
  flowMultiQueryRagName: 'Multi-query RAG',
  flowMultiQueryRagDescription:
    'Plan several search queries, retrieve for all of them, merge, rerank and answer with citations',
  flowMultiRetrievalName: 'Multi-query retrieval',
  flowMultiRetrievalDescription: 'Search with several queries and merge the results',
  flowResearchAssistantName: 'Research assistant',
  flowResearchAssistantDescription:
    'Breadth-first retrieval with a synthesis-heavy answer, for questions that want a survey of the sources rather than a single fact',
  flowRetrieveAndRerankName: 'Retrieve and rerank',
  flowRetrieveAndRerankDescription:
    'Retrieve on the question as written and rerank, without planning or generating an answer',
  flowSummarizationName: 'Summarisation',
  flowSummarizationDescription: 'Generate a summary of the given content',
  blockModelName: 'Ask the language model',
  blockModelDescription: 'One call to the language model with a prompt. Can stream the answer.',
  blockExtractName: 'Extract information',
  blockExtractDescription:
    'The model fills in a schema. With text chunks as the basis, each value gets its source.',
  blockClassifyName: 'Classify',
  blockClassifyDescription: 'Picks exactly one category for a text.',
  blockRetrieveName: 'Search',
  blockRetrieveDescription: "Plans searches and fetches text chunks from the service's datasets.",
  blockRerankName: 'Rank the results',
  blockRerankDescription: 'Ranks the text chunks and puts together the basis the model reads.',
  blockSynthesizeName: 'Write the answer from the basis',
  blockSynthesizeDescription: 'Writes an answer with source references from the basis.',
  blockEvidenceGateName: 'Check whether the basis holds',
  blockEvidenceGateDescription: 'Decides whether there are enough good sources to answer.',
  blockOverviewFinalizeName: 'Finish the overview',
  blockOverviewFinalizeDescription:
    'Finishes an overview, or declines when the basis does not hold.',
  blockAnswerName: 'Deliver the answer with sources',
  blockAnswerDescription: 'Puts together the answer and the list of sources the service delivers.',
  blockTemplateName: 'Put text together',
  blockTemplateDescription: 'Puts text together with values from the earlier steps.',
  blockRouteName: 'Send to a queue',
  blockRouteDescription: 'Notes which queue the case goes to.',
  blockApprovalName: 'Ask a person',
  blockApprovalDescription:
    'Stops the flow until a person has answered, and continues with the answer.',
  blockAgentName: 'Let the model search by itself',
  blockAgentDescription:
    'Lets the model search, read and answer by itself, as one step in the flow.',
  blockDocumentsName: 'Find documents',
  blockDocumentsDescription:
    "Lists documents from the service's datasets by type, organisation, year or id. Writes no text.",
  blockReadDocumentName: 'Read one document',
  blockReadDocumentDescription:
    'Fetches the text chunks of one document, and can rank them by a question and keep the best.',
  blockTableName: 'Make a table with sources',
  blockTableDescription:
    'Puts the results of a loop together into a table where each cell has its source. Can be downloaded as CSV.',
  blockToolName: 'Call a tool',
  blockToolDescription:
    'Calls one tool from a registered tool source with values from the flow, and passes the result on to later steps.',
} satisfies Translation<typeof source>;
