import type { ServiceDraftSummary } from './api/quality';
import type { ServiceSummaryView } from './types';

/** The services Tjenester lists by default: unpublished drafts and every service not archived. */
export const listedServiceCount = (
  services: Pick<ServiceSummaryView, 'lifecycle'>[],
  drafts: Pick<ServiceDraftSummary, 'latestVersion'>[],
) =>
  drafts.filter((d) => d.latestVersion === null).length +
  services.filter((s) => s.lifecycle !== 'archived').length;
