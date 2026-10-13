import type { Translation } from '@genai/i18n';
import type { document as source } from '../nb/document';

export const document = {
  intro:
    'This is how a document made by a service is labelled. The label is at the top and bottom, also in the Word file.',
  aiDraft: 'Draft made with AI',
  bannerText:
    'Check the content before it is sent. The label is removed only when a caseworker has approved the draft.',
  meta: '{agency} · Case number {caseNumber} · {date}',
  fallbackHeading: 'Document draft',
  noProvenance: 'We found no information about how the draft was made. Check it with extra care.',
  download: 'Download as Word',
  goToApprovals: 'Go to approval',
  footerApproved: 'Made with AI by the service {service} and approved by a caseworker',
  footerDraft: 'Draft made with AI by the service {service}',
  footerVersion: 'version {version}',
  footerAt: '{when}.',
  footerBasis: ' Basis: {sources}.',
} satisfies Translation<typeof source>;
