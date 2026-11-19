import { knowledgeFieldsQueue, queueWork, type fieldFills } from '@genai/jobs';
import {
  kudosLinkAndAbbreviationFields,
  kudosOrgNumberFields,
  kudosReportKeyFields,
} from '@genai/ingest';
import type { DocumentRecords, FieldFill, StoredDocument } from '@genai/port-knowledge';

export interface FieldsDeps {
  records: DocumentRecords;
  /** Throws while the knowledge server is bound to another platform server (ADR 0042). */
  bound?: () => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Each fill a `knowledge.fields` job may name: the source whose stored records it reads. */
const fills: Record<(typeof fieldFills)[number], (doc: StoredDocument) => FieldFill> = {
  'kudos-org-numbers': (doc) => ({ fields: kudosOrgNumberFields(doc) }),
  'kudos-links-and-abbreviations': kudosLinkAndAbbreviationFields,
  'kudos-report-keys': (doc) => ({ fields: kudosReportKeyFields(doc) }),
};

/** `knowledge.fields`: new fields on a dataset's stored documents, nothing embedded (ADR 0042). */
export const fieldsWork = (deps: FieldsDeps) =>
  queueWork(knowledgeFieldsQueue, async (job) => {
    deps.bound?.();
    const { dataset, fill } = job.data;
    const result = await deps.records.refreshFields(dataset, fills[fill]);
    deps.log?.('knowledge fields refreshed', { dataset, fill, ...result });
  });
