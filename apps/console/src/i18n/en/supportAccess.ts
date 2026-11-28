import type { Translation } from '@genai/i18n';
import type { supportAccess as source } from '../nb/supportAccess';

export const supportAccess = {
  yes: 'Yes',
  no: 'No',
  notSet: 'Not set',
  frameNote: 'Changes are logged at {tenant} as "Change by Digdir"',
  loadingSettings: 'Loading the settings',
  settingsPath: 'Settings › Organisation',
  tenantLevel:
    'Organisation level. Applies to all services in {tenant} that have no value of their own.',
  noneSettable: 'No settings can be changed at organisation level.',
  save: 'Save',
  unsaved: { one: '{count} unsaved change', other: '{count} unsaved changes' },
  noChanges: 'No changes',
  changeTitle: 'Change on behalf of {tenant}',
  seesChange: 'The change appears in the log of {tenant} as "Change by Digdir" with your name.',
  saveAsDigdir: 'Save as change by Digdir',
  savedAsDigdir: 'Saved as a change by Digdir. {tenant} sees the change in the log.',
  affectsAll: 'Affects all services in {tenant} that have no value of their own.',
  tenant: 'Organisation',
  searchSettings: 'Search settings',
  searchSettingsHelp: 'Search by name, key or description.',
  noSettingMatch: 'No settings match the search.',
  reasonHint: 'At least 10 characters.',
  lockedBy: 'Locked: {reason}',
} satisfies Translation<typeof source>;
