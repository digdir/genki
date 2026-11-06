import { defineNamespace, type Translation } from '@genai/i18n';

export const nbSettings = defineNamespace({
  title: 'Innstillinger',
  colorScheme: 'Fargemodus',
  light: 'Lys',
  dark: 'Mørk',
  // «Auto», not «Automatisk»: three items share the width, and the longest word decides how narrow
  // the other two get.
  auto: 'Auto',
  answers: 'Svar',
  displayLevelQuestion: 'Hvor mye skal svaret vise om hvordan det ble til?',
  standard: 'Standard',
  standardDescription:
    'Fremgangsmåte over svaret, med stegene assistenten gikk gjennom og søkeordene den brukte.',
  detailed: 'Detaljert',
  detailedDescription:
    'Alt det tekniske i tillegg: søkestrengene for hvert steg, antall treff og tiden det tok.',
  experiments: 'Eksperimenter',
  experimentsIntro: 'Forsøk som ikke er bestemt ennå. Alle er av til du slår dem på.',
  readMore: 'Les mer',
  newTab: '(åpnes i ny fane)',
  linksLabel: 'Innstillinger og om {name}',
  linksLabelUnnamed: 'Innstillinger og om tjenesten',
});

export const enSettings = {
  title: 'Settings',
  colorScheme: 'Colour scheme',
  light: 'Light',
  dark: 'Dark',
  auto: 'Auto',
  answers: 'Answers',
  displayLevelQuestion: 'How much should the answer show of how it was made?',
  standard: 'Standard',
  standardDescription:
    'The approach above the answer, with the steps the assistant went through and the search words it used.',
  detailed: 'Detailed',
  detailedDescription:
    'Everything technical as well: the search strings for each step, the number of hits and the time it took.',
  experiments: 'Experiments',
  experimentsIntro: 'Trials that are not decided yet. All are off until you turn them on.',
  readMore: 'Read more',
  newTab: '(opens in a new tab)',
  linksLabel: 'Settings and about {name}',
  linksLabelUnnamed: 'Settings and about the service',
} satisfies Translation<typeof nbSettings>;
