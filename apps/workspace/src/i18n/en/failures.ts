import type { Translation } from '@genai/i18n';
import type { failures as source } from '../nb/failures';

export const failures = {
  platformTopic: 'This question cannot be answered in this service.',
  platformSources: 'I found no sources that support an answer, so I will not answer this.',
  paused: 'The model the service uses has been withdrawn',
  quotaTitle: 'The quota is used up',
  quotaText:
    '{organisation} has used the whole quota for {month}. The service works again on 1 {next}, or when an administrator raises the quota. What you wrote has not been saved.',
  unavailableTitle: 'The language model is not responding right now',
  unavailableText: 'There is nothing wrong with your question. Try again in a few minutes.',
  tryAgain: 'Try again',
  serviceFailedTitle: 'The service failed',
  serviceFailedText:
    'Something went wrong in the service, not in your question. Try again, or see Error messages.',
  refusedTitle: 'I cannot answer this',
  refusedText: 'The service does not answer this kind of question.',
  noSourcesTitle: 'No sources found',
  noSourcesText:
    'I found nothing in the sources that answers this, so I will not answer. Try other words.',
  signedOutTitle: 'You are logged out',
  signedOutText: 'Reload the page to log in again. What you wrote has not been saved.',
  pausedTitle: 'Paused',
  invalidTitle: 'The service could not use what you sent',
  invalidText: 'Check what you wrote, or the fields in the form, and send again.',
  noAccessTitle: 'You do not have access to this service',
  noAccessText:
    'Ask the person who manages access in your organisation for access, or choose another service.',
  runFailed: 'The service failed while running.',
} satisfies Translation<typeof source>;
