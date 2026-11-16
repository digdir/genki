import type { TemplateId } from '@genai/ui-blocks/builder';
import type { PlainKey } from '../../../i18n';

/**
 * The starting points («Utgangspunkt») the builder offers, in their order and with the portal's
 * names. Each is a template in `@genai/ui-blocks`; where one of the design's templates is already
 * the same blocks, that template is used.
 */
export const startingPoints: readonly { id: TemplateId; name: PlainKey }[] = [
  { id: 'all-blocks', name: 'builderBlocks.templateAll' },
  { id: 'sources-only', name: 'builderBlocks.templateSourcesFocus' },
  { id: 'approach-only', name: 'builderBlocks.templateProcedureFocus' },
  { id: 'notes-focus', name: 'builderBlocks.templateNotesFocus' },
  { id: 'document-focus', name: 'builderBlocks.templateDocumentFocus' },
  { id: 'classic', name: 'builderBlocks.templateClassic' },
  { id: 'without-secondary', name: 'builderBlocks.templateNoRight' },
  { id: 'chat-and-sources', name: 'builderBlocks.templateNoLeft' },
  { id: 'chat-only', name: 'builderBlocks.templateChatOnly' },
];
