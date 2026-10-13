import type { Translation } from '@genai/i18n';
import type {
  apiCall as apiCallSource,
  components as componentsSource,
  publish as publishSource,
  resultTable as resultTableSource,
  runFailure as runFailureSource,
} from '../nb/core-components';

export const components = {
  breadcrumbs: 'Breadcrumbs',
  notAvailableTitle: 'Not available yet',
  notDecided: 'Not decided',
  steps: 'Steps',
  stepDone: ' (completed)',
  locationNorway: 'Data in Norway',
  locationEu: 'Data in the EU/EEA',
  locationGlobal: 'Data outside the EU/EEA',
  todayAt: 'today at {time}',
  changeLogged: 'Changed by {by} {when}: "{reason}". Logged.',
} satisfies Translation<typeof componentsSource>;

export const apiCall = {
  eyebrow: 'API call for "{action}"',
  notDecidedFor: 'There is no API for {what} yet.',
  notDecidedNote: 'The call is a proposal following the same pattern as the rest of the API.',
  intro:
    'This is the call the button makes, with the values you have chosen. The token is your own token from Ansattporten, and it is not shown.',
  copyRequest: 'Copy the request',
  request: 'Request',
  rightRequired: 'Right required',
  replaceToken: 'Replace $TOKEN with your own token.',
  replaceReason: 'Replace {placeholder} with a reason of at least 10 characters, percent-encoded.',
  seeEndpoint: 'See the endpoint in the API reference',
} satisfies Translation<typeof apiCallSource>;

export const runFailure = {
  hintMisconfigured: 'Fix the setup of the step in the builder, and try again.',
  hintForbidden: 'Check that the service has access to the datasets and building blocks it uses.',
  hintSmaller: 'Try with less input, or raise the limit for the service under Settings.',
  hintDeadline: 'Try with less input, or split the job up.',
  defaultTitle: 'The service failed while running.',
  stepFailed: 'The step "{step}" failed.',
  heading: 'The run failed',
  technical: 'Technical message',
  seeInLog: 'See the run in Log',
  noAnswer: 'We did not get an answer from the model',
} satisfies Translation<typeof runFailureSource>;

export const publish = {
  lockedByGate:
    'Publishing is locked because a quality requirement is not met. See the explanation above.',
  publishedFirst: 'Version {next} is published and in use.',
  publishedNext:
    'Version {next} is published and in use. Version {current} can be restored under Versions.',
  failed: 'Publishing failed. Nothing has changed. Try again.',
  publishedToTest:
    'Version {next} is published to test. It is only available in the test environment.',
  updateAvailable: 'Update available',
  fromDigdir: 'From Digdir',
  updateIntro:
    'Digdir has made new versions available. The service does not switch on its own. Your test set has been run with the new versions.',
  testSet: 'Test set {score}',
  include: 'Include in v{next}',
  changes: 'Changes',
  firstVersion: 'Version {next}, first version',
  changedSince: 'Version {next}, changed since version {current}',
  changedSinceInTest: 'Version {next} in test, changed since version {current}',
  updateFromDigdir: 'Update from Digdir: {name}',
  gates: 'Quality requirements',
  passed: 'Passed',
  notPassed: 'Not passed',
  cannotPublishYet: 'Cannot be published yet',
  gatesNotMet: {
    one: '{failed} of {count} quality requirement is not met. The requirement "{name}" is set by {tenant} and cannot be overridden here. You can still publish to test.',
    other:
      '{failed} of {count} quality requirements are not met. The requirement "{name}" is set by {tenant} and cannot be overridden here. You can still publish to test.',
  },
  reasonLabel: 'What changed, and why?',
  reasonHelp: 'Required. Shown in the version history and in Log under Changes.',
  previousStays:
    'Version {current} stays in place. You can roll back to it at any time under Versions.',
  publish: 'Publish',
  publishToTest: 'Publish to test',
  statusPublished: 'Version {next} is published.',
  statusLocked: 'Publishing is locked until all requirements are passed.',
  statusAllPassed: 'All requirements are passed.',
} satisfies Translation<typeof publishSource>;

export const resultTable = {
  result: 'Result',
  source: 'Source',
  sourceN: 'Source {n}: {name}',
  sources: 'Sources',
  skipped: 'Skipped because they could not be read: {names}.',
  item: 'item {n}',
  download: 'Download CSV',
  fileName: 'table',
} satisfies Translation<typeof resultTableSource>;
