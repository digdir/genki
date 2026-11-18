import type { Translation } from '@genai/i18n';
import type { operations as source } from '../nb/operations.js';

export const operations = {
  minutes: '{minutes} min',
  hours: '{hours} h',
  hoursMinutes: '{hours} h {minutes} min',
  database: 'Database',
  databaseAnswered: 'Responded in {ms} ms.',
  databaseDown: 'Not responding.',
  models: 'Models: {endpoint}',
  modelsInUse: '{enabled} of {total} models in use.',
  runs: 'Runs',
  ingestion: 'Ingestion',
  ingestionUnavailable: 'Ingestion is not available.',
  scheduledIngestion: 'Scheduled ingestion: {pipeline} · {dataset}',
  ingestionFailed: 'The ingestion failed.',
  runningIngestions: 'Ingestions running',
  failedIngestions: 'Ingestions failed in the last 24 hours',
  activeRuns: 'Runs in progress',
  longestIngestion: 'Longest running ingestion',
  switchChooseEngine: 'choose a search engine',
  switchUnknownEngine: 'unknown search engine {to}',
  switchSameEngine: 'The dataset already uses this search engine.',
  switchWriteKeyRequired: 'Needs its own write key',
  switchCannotWrite: 'The platform cannot write to this search engine.',
  switchSharedStorage: 'The search engines share storage. Choose another search engine.',
  switchMissingModel: 'The embedding model {model} is not set up on the platform.',
  switchCopyNeedsSameModel:
    'Copying needs the same embedding model. Now {current} is used, the new search engine uses {wanted}. Ingest again from the source.',
  switchCannotRead: 'The platform cannot read the documents from the current search engine.',
  switchNoPipeline: 'The dataset has no ingestion to run.',
  switchBusy: 'A switch is already running ({id}).',
  switchStalled: 'The transfer stopped. Start it again.',
  switchKnowledgeCopyExport:
    "The dataset's search engine cannot hand over its documents one by one, so they cannot be copied into the knowledge database. Re-ingest from the source.",
  switchModelResidency:
    'The model {model} cannot be used on this dataset: it processes data outside where the dataset may be processed.',
  switchNoModelForResidency:
    'No embedding model can process this dataset where it may be processed, so it cannot be copied into the knowledge database.',
  switchKnowledgeNeedsModel: 'Choose an embedding model: the dataset has none.',
  switchCopySubset:
    'This switch copied only a selection of documents, so it cannot be activated. Start a copy of the whole dataset.',
  switchCopyDocuments:
    'documents is a list of 1 to 1000 document ids, only for a copy into the knowledge database.',
  switchKnowledgeOnePipeline:
    'A dataset on the knowledge database is filled by one pipeline until co-owners are built; this one has {pipelines}.',
  switchKnowledgePhrases:
    'Search phrases cannot fill a dataset on the knowledge database until recipes hold them ({pipeline}).',
  switchRunCancelled: 'The run {run} was cancelled.',
} satisfies Translation<typeof source>;
