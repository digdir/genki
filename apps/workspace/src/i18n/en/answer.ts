import type { Translation } from '@genai/i18n';
import type { answer as source } from '../nb/answer';

export const answer = {
  conversation: 'Conversation',
  attached: 'Attached: {names}',
  youWrote: 'You wrote: ',
  version: 'version {version}',
  excerpt: 'Excerpt',
  noAnswer: 'No answer found in the sources',
  aiTag: 'Answer made with AI',
  working: 'Making the answer …',
  table: 'Table',
  rows: { one: '{count} row', other: '{count} rows' },
  unreadable: ', {count} could not be read',
  openTable: 'Open the table with sources',
  sources: 'Sources',
  cite: 'Source {n}: {title}',
  untitledSource: 'Untitled source',
} satisfies Translation<typeof source>;
