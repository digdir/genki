import type { Translation } from '@genai/i18n';
import type { chat as source } from '../nb/chat';

export const chat = {
  aiNotice:
    '<strong>The answers are made by AI.</strong> They can be wrong or incomplete. Check the sources before you use them.',
  processedBy: 'Questions and answers are processed {processing}.',
  processedByPlatform:
    'Questions and answers are processed by the shared platform for generative AI.',
  dataPolicy: 'How data is processed',
  answerFailed: 'The answer could not be made.',
  answerReady: 'The answer is ready.',
  writeQuestion: 'Write a question.',
  noPersonalData: 'Do not write names or other personal data.',
  service: 'Service',
  pausedOption: '{name} (paused)',
  pausedServices: 'Paused services',
  pausedItem: '{name} is paused: {reason}',
  paused: 'Paused: {reason}',
  fixBeforeRun: 'To run the service, you need to fix the following:',
  note: 'Anything else the service should know?',
  optional: '(optional)',
  showApiCall: 'Show API call',
  runService: 'Run the service',
  changeChoices: 'Change your choices',
  working: 'Making the answer. You can visit other pages in the workspace in the meantime.',
  askQuestion: 'Ask a question',
  askFollowUp: 'Ask a follow-up question',
  send: 'Send',
  batchNotice:
    'This service runs as one job over many documents, not as a conversation. Start the job from the service in the portal.',
  batchLink: 'Open the service in the portal',
  newConversation: 'New conversation',
  pastConversations: 'Earlier conversations',
  untitledConversation: 'Untitled conversation',
  pastFailed: 'Could not open the conversation. Try again.',
  attach: 'Attach files',
  attachHelp:
    'Text files ({types}), up to {size} per file and {count} files. The files go with every question in the conversation.',
  attached: 'Attached files',
  removeDocument: 'Remove {name}',
  documentWrongType: 'The service cannot read {name}. Choose a text file.',
  documentTooLarge: '{name} is too large. The limit is {size}.',
  documentTooMany: 'You can attach up to {count} files.',
  documentUnreadable: 'Could not read {name}. Try again.',
} satisfies Translation<typeof source>;
