import type { Translation } from '@genai/i18n';
import type { blockImport as nb } from '../nb/block-import.js';

export const blockImport = {
  bodyTooLarge: 'The request is larger than {limit}',
  tooLarge: 'The design is larger than 512 KiB',
  empty: 'The design has no content',
  tooMuchText:
    'The design has too much text: at most 200 texts of at most 1000 characters each. Split the long texts.',
  codeScript:
    'The design has scripts, which need a design element with code. It cannot be imported yet.',
  codeAnimation:
    'The design has animations, which need a design element with code. It cannot be imported yet.',
  codeElement:
    'The design has the element <{element}>, which needs a design element with code. It cannot be imported yet.',
  codeLimits:
    'The design has {nodes} elements and is {depth} levels deep, which needs a design element with code. It cannot be imported yet.',
  codeInvalid:
    'The template was not valid at {path}, so the design needs a design element with code. It cannot be imported yet.',
  mustBeText: 'must be text',
  mustBeSlug: 'must be lowercase letters, digits and dashes',
  invalid: 'The design did not become a valid design element',
  convertedDeclarative: 'Made as a design element without code',
  droppedScript: 'Removed scripts loaded from elsewhere',
  droppedStylesheet: 'Removed stylesheets and fonts loaded from elsewhere',
  droppedHandler: 'Removed event code in attributes such as onclick',
  droppedLink: 'Removed links that are not https',
  droppedBase: 'Removed the base address',
  droppedStyle: 'Removed styles; the design element uses Designsystemet',
  droppedElement: 'Removed the element <{element}>',
  colours: 'The colours follow the theme',
  englishLeftOut: 'The texts are in bokmål only; add English in Design',
  buttonWithoutEvent: 'A button without data-genki-event became text',
  linkAsText: 'A link inside running text became text',
  bindOutsideFields: '{path} is not a field the design element can read, so it stays as text',
  eachOutsideFields: '{path} is not a list the design element can repeat',
} satisfies Translation<typeof nb>;
