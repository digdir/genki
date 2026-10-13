import type { Translation } from '@genai/i18n';
import type { languageTabs as source } from '../nb/setup-languages';

export const languageTabs = {
  tabsLabel: 'Instructions per language',
  tabShared: 'Shared',
  tabNb: 'Bokmål',
  tabNn: 'Nynorsk',
  tabEn: 'English',
  houseStyle: 'House style',
  houseStyleHelp: 'Added after the shared instructions when the answer is in this language.',
  fromPlatform: 'From Digdir',
  fromTenant: 'From the organisation',
  fromService: 'Overridden for the service',
  noHouseStyle: 'No house style for this language.',
  loadingHouseStyle: 'Fetching the house style …',
  houseStyleUnavailable: 'Could not fetch the house style. The service still uses it.',
  override: 'Override',
  useInherited: 'Use the inherited house style',
  overrideLabel: 'House style for this service',
  serviceText: 'Text for the service in this language',
  serviceTextHelp: 'The service’s own words and phrasing, added after the house style.',
  notAnswered:
    'The service does not answer in this language. Questions in it are answered in {first}.',
  fullPrompt: 'Full instructions in this language',
  fullPromptHelp:
    'Used instead of the shared instructions when the answer is in this language. Every language the service answers in needs one.',
  fullPromptMissing: 'This language has no instructions.',
  fullPromptOffer:
    'Do the languages need completely different instructions? Then you can write full instructions per language instead of using the shared ones.',
  writeSeparately: 'Write separate instructions per language',
  useShared: 'Use the shared instructions again',
  sharedUnused:
    'The service has full instructions per language. This shared text is not used until you choose the shared instructions again.',
} satisfies Translation<typeof source>;
