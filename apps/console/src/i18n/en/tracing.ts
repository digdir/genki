import type { Translation } from '@genai/i18n';
import type { tracing as source } from '../nb/tracing';

export const tracing = {
  title: 'Tracing and evaluation for the platform',
  intro: 'Where the platform sends traces for all organisations.',
  sourceNote:
    "The platform's own log is always the source. External tools get a copy, and can be connected and disconnected without changing the services.",
  fixedRule: 'Fixed rule, cannot be changed:',
  fixedRuleText:
    ' the names of employees are never sent to external tools. The person is shown as "Employee at the organisation" with a fixed pseudonym per service.',
  loading: 'Loading tracing status',
  envTitle: "The platform's tracing",
  on: 'On',
  off: 'Off',
  envNote: "Set by the API's configuration at start-up.",
  target: 'Target',
  content: 'Content',
  fullContent: 'Full content',
  metaOnly: 'Metadata only',
  shareSent: 'Share sent',
  sent: 'Sent',
  failed: 'Failed',
  percent: '{value}%',
  unavailableTitle: 'Not available yet',
  unavailableText:
    'Connecting and configuring tracing tools from the console is not available yet.',
} satisfies Translation<typeof source>;
