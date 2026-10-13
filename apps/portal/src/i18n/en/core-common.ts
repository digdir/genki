import type { Translation } from '@genai/i18n';
import type {
  common as commonSource,
  rights as rightsSource,
  taskStatus as statusSource,
} from '../nb/core-common';

export const common = {
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  tryAgain: 'Try again',
  loading: 'Loading …',
  back: 'Back',
  next: 'Next',
  previous: 'Previous',
  edit: 'Edit',
  add: 'Add',
  remove: 'Remove',
  delete: 'Delete',
  copy: 'Copy',
  copied: 'Copied',
  yes: 'Yes',
  no: 'No',
  search: 'Search',
  open: 'Open',
  apiCall: 'Show API call',
  reason: 'Reason',
  reasonTooShort: 'Write a reason of at least {min} characters.',
  needsRight: 'You need the right "{right}".',
  notPriced: 'Not priced',
  actorOperator: 'Digdir',
  actorEmployee: 'Employee at the organisation',
  actorPlatform: 'The platform',
  seconds: '{value} s',
  ore: '{value} øre',
  unknown: 'Unknown',
} satisfies Translation<typeof commonSource>;

export const rights = {
  useServices: 'Use services',
  manageServices: 'Manage services',
  manageDatasets: 'Manage datasets',
  registerBuildingBlocks: 'Register building blocks',
  viewUsage: 'See usage and cost',
  read: 'Read',
  write: 'Write',
} satisfies Translation<typeof rightsSource>;

export const taskStatus = {
  queued: 'Queued',
  running: 'Running',
  interrupted: 'Waiting for approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
} satisfies Translation<typeof statusSource>;
