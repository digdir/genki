import type { Translation } from '@genai/i18n';
import type { services as source } from '../nb/services.js';

export const services = {
  assistantRefused:
    'The building assistant is turned off for the organisation. An administrator can turn it on under Settings. The form works as usual.',
  assistantUnavailable:
    'The assistant is not responding right now. The form works as usual, and nothing has changed. Try again in a little while.',
  assistantNoModel:
    'No model with tool support is available for the building assistant. An administrator can choose a model under Settings.',
  assistantBudget:
    'The assistant has used up {tokens} tokens for today. The quota renews at 00:00. The form works as usual.',
  assistantNotPublished:
    'The building assistant is not published on the platform yet. The form works as usual.',
  assistantNeedsRight: 'Needs approval from someone with the right "{right}".',
  optimiserNotPublished: 'The improvement service is not published on the platform yet.',
  improvementLanguageUnknown: 'The language must be nb, nn or en.',
  improvementNoLanguageText:
    'The service has no text of its own for the language "{language}". Write one under Instructions first.',
  platformStrategyOnly: 'Only the platform can publish services with this strategy.',
  rightUseServices: 'Use services',
  rightManageServices: 'Manage services',
  rightManageDatasets: 'Manage datasets',
  rightRegisterBuildingBlocks: 'Register building blocks',
  rightViewUsage: 'View usage and cost',
  blockNeedsApproval: '"{name}" must be approved before the organisation can use it.',
  notAllowedHere: '{id} is not allowed in your organisation.',
  needsApproval: '{id} must be approved before it can be used.',
  notCounted: 'Nothing is saved, and the run does not count towards the quota.',
  modelUnavailable:
    'We did not get a response from the model. Nothing is saved, and the run does not count towards the quota.',
  failedNotCounted: '{reason} Nothing is saved, and the run does not count towards the quota.',
  extractInstructions: 'Extract the information from the document.',
  answerInstructions: 'Answer briefly and precisely in English.',
  testedOnDraft: 'The test set has run on the draft',
  runOnDraft: 'Run the test set on this version of the draft.',
  passRate: 'At least {percent} per cent of the test cases pass',
  passedOf: '{passed} of {total} passed',
  noDraftRun: 'No test run on the draft.',
  mustReject: 'All cases that should be refused are refused',
  notRejected: { one: '{count} case was not refused', other: '{count} cases were not refused' },
  publishedTools: 'The tools point to published versions',
  placeNorway: 'in Norway',
  placeEu: 'in the EU/EEA',
  placeGlobal: 'outside the EU/EEA',
  modelRetired: 'The model {id} has been retired.',
  modelReclassified:
    'The model {id} is now classified to process data {place}, but the service requires {required}.',
  primaryRetired: 'The model the service uses has been retired ({id}).',
  retired: 'The model the service uses has been retired',
  engineHttp: 'Search over HTTP',
  engineMcp: 'Search through MCP',
  templateName: 'New service',
  templatePurpose: 'Describe what the service should do',
  pluginBuiltinTools: 'Built-in tools',
  pluginMemoryBlob: 'Memory store',
  pluginDiskBlob: 'File store on disk',
  connectorDataset: 'Rows from {table}, read by the connector for {service}.',
  connectorName: 'Connector for {service}',
  seedReason: 'Loaded from the local configuration',
  archivedByTenant: 'The service is archived and cannot be run.',
  pausedByTenant: 'The service is paused. Reason: {reason}',
  variantAnswer: 'Answers with sources',
  variantDefault: 'Default',
  variantRetrieveOnly: 'Search only',
  boundOutside: 'The API key is bound to the service {service} and cannot use {name}.',
  devLoginUnknownPerson: 'The test person was not found',
} satisfies Translation<typeof source>;
