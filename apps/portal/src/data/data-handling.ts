import type { PlainKey } from '../i18n';

export const dataHandlingPath = '#/data-handling';

export const stored: PlainKey[] = [
  'dataHandling.stored1',
  'dataHandling.stored2',
  'dataHandling.stored3',
];

export const access: PlainKey[] = [
  'dataHandling.access1',
  'dataHandling.access2',
  'dataHandling.access3',
];

export const logged: PlainKey[] = ['dataHandling.logged1', 'dataHandling.logged2'];

export const marking: PlainKey[] = ['dataHandling.marking1', 'dataHandling.marking2'];

export const undecided: readonly (readonly [PlainKey, PlainKey])[] = [
  ['dataHandling.undecidedStorage', 'dataHandling.notDecidedYet'],
  ['dataHandling.undecidedDpa', 'dataHandling.notDecidedYet'],
];
