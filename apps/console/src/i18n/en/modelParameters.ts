import type { Translation } from '@genai/i18n';
import type { modelParameters as source } from '../nb/modelParameters';

export const modelParameters = {
  open: 'Parameters',
  openFor: 'Parameters for {model}',
  title: 'Parameters for {model}',
  text: 'Some models reject parameters that services send. Here you decide what the platform sends to this model, regardless of what the services have set.',
  save: 'Save parameters',
  temperature: 'Temperature',
  reasoning: 'Reasoning level',
  maxTokens: 'Longest answer (tokens)',
  modeSend: 'Send as the service has set it',
  modeUnsupported: 'The model does not support it, do not send',
  modeFixed: 'Always send a fixed value',
  fixedValue: 'Fixed value for {name}',
  invalid: 'The fixed value is not valid for {name}.',
  reasoningLow: 'Low',
  reasoningMedium: 'Medium',
  reasoningHigh: 'High',
  ruleUnsupported: '{name}: not sent',
  ruleFixed: '{name}: fixed {value}',
  rejectedTitle: 'The model has rejected {name}',
  rejectedText:
    'The model answered that it does not accept {name}. The platform retried without it, so services keep working. Last seen {when}. Choose "The model does not support it" under Parameters to make it a fixed rule.',
  rejectedHint: 'Has rejected {name}',
  saved: 'The parameters for {model} are saved. The change is logged in Audit.',
} satisfies Translation<typeof source>;
