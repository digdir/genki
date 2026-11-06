import { defineNamespace, type Translation } from '@genai/i18n';

export const nbStates = defineNamespace({
  retry: 'Prøv igjen',
  goHome: 'Gå til forsiden',
  notFoundTitle: 'Siden finnes ikke',
  notFoundDescription:
    'Adressen fører ingen steder. Den kan være skrevet feil, eller peke på noe som er borte.',
});

export const enStates = {
  retry: 'Try again',
  goHome: 'Go to the front page',
  notFoundTitle: 'The page does not exist',
  notFoundDescription:
    'The address leads nowhere. It may be mistyped, or point to something that is gone.',
} satisfies Translation<typeof nbStates>;
