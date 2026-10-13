import type { Translation } from '@genai/i18n';
import type { sharedServices as source } from '../nb/sharedServices';

export const sharedServices = {
  title: 'Shared services',
  intro: 'The shared services Digdir operates and all organisations can use.',
  note: "Services shared with all organisations appear in every organisation's portal. A change publishes a new version of the service.",
  reasonHint: 'Required to change the sharing. The reason is saved in the audit log.',
  sharedAll: '{name} is now shared with all organisations.',
  unsharedAll: '{name} is no longer shared with everyone.',
  changeFailed: 'Could not change the sharing of {name}.',
  loading: 'Loading services',
  noneTitle: 'No services yet',
  noneText: 'When an organisation publishes a service, you can share it from here.',
  tableLabel: 'Services and sharing',
  colService: 'Service',
  colOwner: 'Owner',
  colVersion: 'Version',
  colSharedWith: 'Shared with',
  colChange: 'Change',
  sharingAll: 'All organisations',
  sharingOwner: 'Owner only',
  sharingSome: { one: '{count} organisation', other: '{count} organisations' },
  stopSharingFor: 'Stop sharing {name} with everyone',
  stopSharing: 'Stop sharing',
  shareFor: 'Share {name} with all organisations',
  share: 'Share with all',
} satisfies Translation<typeof source>;
