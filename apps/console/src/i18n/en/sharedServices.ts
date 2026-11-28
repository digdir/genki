import type { Translation } from '@genai/i18n';
import type { sharedServices as source } from '../nb/sharedServices';

export const sharedServices = {
  title: 'Shared services',
  note: "Services shared with all organisations appear in every organisation's portal. A change publishes a new edition of the service.",
  sharedAll: '{name} is now shared with all organisations.',
  unsharedAll: '{name} is no longer shared with everyone.',
  ownerOnly: '{name} is now available to its owner only.',
  changeFailed: 'Could not change the sharing of {name}.',
  loading: 'Loading services',
  noneTitle: 'No services yet',
  noneText: 'When an organisation publishes a service, you can share it from here.',
  colService: 'Service',
  colOwner: 'Owner',
  colVersion: 'Edition',
  colSharedWith: 'Shared with',
  colChange: 'Change',
  sharingAll: 'All organisations',
  sharingOwner: 'Owner only',
  sharingSome: { one: '{count} organisation', other: '{count} organisations' },
  everyone: 'Everyone',
  changeFor: 'Change {name}',
  changeTitle: 'Change the sharing of {name}',
  unchanged: 'Choose a different sharing from the one that applies now.',
  save: 'Save',
} satisfies Translation<typeof source>;
