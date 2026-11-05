import type { Translation } from '@genai/i18n';
import type { engineSwitch as source } from '../nb/engineSwitch';

export const engineSwitch = {
  title: 'Search engine',
  loading: 'Loading the search engine',
  current: 'Search engine now: {endpoint}',
  move: 'Move to the knowledge database',
  target: 'To search engine',
  reingestNote:
    'The dataset is read in again from its source. Services search the old engine until you put the new one in use.',
  start: 'Start the move',
  close: 'Close',
  noTargets:
    'There is no search engine on the knowledge database yet. Make one under Search engines, with the connection Knowledge server.',
  route: 'From {from} to {to}',
  stateRunning: 'Reading in',
  stateFailed: 'Reading in failed',
  stateComparing: 'Comparing the searches',
  stateReady: 'Ready to put in use',
  stateActivating: 'Putting in use',
  stateActive: 'In use',
  stateRolledBack: 'Rolled back',
  stateCancelled: 'Cancelled',
  progress: '{percent} % ({documents} documents)',
  generation: 'Generation {generation}',
  failedDocuments: {
    one: '{count} document could not be read in',
    other: '{count} documents could not be read in',
  },
  estimate:
    'Reading in again: {costMin}–{costMax} NOK, {minutesMin}–{minutesMax} min ({documents} documents)',
  copyEstimate:
    'Copy: {costMin}–{costMax} NOK, {minutesMin}–{minutesMax} min ({documents} documents, {chunks} chunks)',
  copyNote:
    'The dataset is copied from the engine it is on now, with its text as it is there, and gets new vectors. Services search the old engine until you put the new one in use.',
  model: 'Embedding model',
  chooseModel: 'Choose a model',
  copyCounts: 'Copied: {copied} · skipped: {skipped}{reasons} · failed: {failed}',
  skipNoUuid: '{count} without a UUID',
  skipSameUuid: '{count} with the same UUID',
  skipNoText: '{count} without text',
  subset: 'A selection of {count} documents: it can be compared, not put in use.',
  notAvailable: 'The move cannot start.',
  loadingEstimate: 'Working out cost and time',
  noEstimate: 'Could not work out what the move costs. Try again.',
  comparison: 'Hits among the first five: {from} {before} %, {to} {after} % ({cases} questions)',
  worse: 'The new search engine finds less. The reason needs at least {min} characters.',
  errorLead: 'Reading in stopped. The message from the platform:',
  activate: 'Put in use',
  retry: 'Try again',
  cancel: 'Cancel the move',
  keptUntil: '{endpoint} is kept until {date}, so the move can be rolled back.',
  rollback: 'Roll back to {endpoint}',
  failed: 'The platform refused the change. Try again.',
} satisfies Translation<typeof source>;
