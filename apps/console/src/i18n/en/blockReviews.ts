import type { Translation } from '@genai/i18n';
import type { blockReviews as source } from '../nb/blockReviews';

export const blockReviews = {
  title: 'Design elements in review',
  loading: 'Loading design elements',
  tableLabel: 'Design elements in review',
  empty: 'No design elements are waiting for review.',
  colOrganisation: 'Organisation',
  colBlock: 'Design element',
  colVersion: 'Edition',
  colSent: 'Sent',
  open: 'Review',
  openFor: 'Review {name}',
  detailTitle: '{name}, edition {version}',
  requestReason: 'Reason from {who}: {reason}',
  reads: 'Reads',
  events: 'Events',
  none: 'None',
  size: 'Size: {bytes} bytes',
  bundle: 'Bundle',
  bundleIsApproved:
    'The bundle is what you approve. The sources are only an aid and are not tied to the bundle.',
  source: 'Source: {path}',
  approve: 'Approve',
  decline: 'Decline',
  approved: '{name} is shared with everyone, as edition {version}.',
  declined: '{name} is declined.',
  failed: 'The decision was not saved.',
} satisfies Translation<typeof source>;
