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
  attachmentsLabel: 'Attachments',
  attachmentLoading: 'Fetching the attachment …',
  attachmentFailed: 'The attachment cannot be shown here. You may not have access to the run.',
  attachmentMeta: '{mediaType} · {size}',
  attachmentFromStep: 'from the step {step}',
  attachmentImage: 'Image from the step {step}',
  attachmentImagePlain: 'Image from the answer',
  attachmentOpen: 'Download',
  bytes: '{n} bytes',
  kilobytes: '{n} kB',
  megabytes: '{n} MB',
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
  hintForbidden:
    'Check that the service has access to the document collections and the catalogue parts it uses.',
  hintSmaller: 'Try with less input, or raise the limit for the service under Limits and logging.',
  hintDeadline: 'Try with less input, or split the job up.',
  defaultTitle: 'The service failed while running.',
  stepFailed: 'The step "{step}" failed.',
  heading: 'The run failed',
  technical: 'Technical message',
  seeInLog: 'See the run in Log',
  noAnswer: 'We did not get an answer from the model',
} satisfies Translation<typeof runFailureSource>;

export const publish = {
  leftHeading: 'This is left before you can publish',
  leftProblem: '{area}: {problem}',
  leftConfirmRisk: 'Confirm the risk level',
  leftForbidden: 'Remove what the AI Act forbids, under Risk and the AI Act',
  leftUnmasked: 'Give a reason for the content sent unmasked',
  leftChecking: 'Wait until the draft has been checked',
  testsetHeading: 'Recommended: make a test set',
  testsetFirst:
    'Without a test set you cannot see whether changes make the results worse. Test sets are made under Quality once the service is published. It does not stop publishing.',
  colWhat: 'What',
  colVersion: 'Edition {next}',
  confirmed: 'Confirmed',
  notConfirmed: 'Not confirmed',
  cannotYet:
    'You cannot publish yet. Do what is listed under «This is left before you can publish» first.',
  lockedByGate:
    'Publishing is locked because a quality requirement is not met. See the explanation above.',
  publishedFirst: 'Edition {next} is published and in use.',
  publishedNext:
    'Edition {next} is published and in use. You can undo the publishing under History.',
  failed: 'Publishing failed. Nothing has changed. Try again.',
  publishedToTest: 'Edition {next} is now the test edition. It is not in use yet.',
  updateAvailable: 'Update available',
  fromDigdir: 'From Digdir',
  updateIntro:
    'Digdir has made new editions available. The service does not switch on its own. Your test set has been run with the new editions.',
  testSet: 'Test set {score}',
  include: 'Include in v{next}',
  changes: 'Changes',
  firstVersion: 'Edition {next}, the first edition',
  changedSince: 'Edition {next}, changed since edition {current}',
  changedSinceInTest: 'Test edition {next}, changed since edition {current}',
  updateFromDigdir: 'Update from Digdir: {name}',
  gates: 'Quality requirements',
  passed: 'Passed',
  notPassed: 'Not passed',
  cannotPublishYet: 'Cannot be published yet',
  gatesNotMet: {
    one: '{failed} of {count} quality requirement is not met. The requirement "{name}" is set by {tenant} and cannot be overridden here.',
    other:
      '{failed} of {count} quality requirements are not met. The requirement "{name}" is set by {tenant} and cannot be overridden here.',
  },
  gatesNotMetTest: 'You can still publish as a test edition.',
  reasonLabel: 'What changed, and why?',
  reasonHelp: 'Required. Shown in History and in Log under Changes.',
  previousStays:
    'Edition {current} stays in place. You can undo the publishing at any time under History.',
  publish: 'Publish',
  publishToTest: 'Publish as test edition',
  statusPublished: 'Edition {next} is published.',
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
