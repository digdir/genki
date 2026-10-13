import { defineNamespace } from '@genai/i18n';

export const languageTabs = defineNamespace({
  tabsLabel: 'Instruksjoner per språk',
  tabShared: 'Felles',
  tabNb: 'Bokmål',
  tabNn: 'Nynorsk',
  tabEn: 'English',
  houseStyle: 'Husstil',
  houseStyleHelp: 'Legges til etter de felles instruksjonene når svaret er på dette språket.',
  fromPlatform: 'Fra Digdir',
  fromTenant: 'Fra virksomheten',
  fromService: 'Overstyrt for tjenesten',
  noHouseStyle: 'Ingen husstil for dette språket.',
  loadingHouseStyle: 'Henter husstilen …',
  houseStyleUnavailable: 'Fikk ikke hentet husstilen. Tjenesten bruker den likevel.',
  override: 'Overstyr',
  useInherited: 'Bruk arvet husstil',
  overrideLabel: 'Husstil for denne tjenesten',
  serviceText: 'Tekst for tjenesten på dette språket',
  serviceTextHelp: 'Egne ord og vendinger for tjenesten, lagt til etter husstilen.',
  notAnswered: 'Tjenesten svarer ikke på dette språket. Spørsmål på det besvares på {first}.',
  fullPrompt: 'Hele instruksjonen på dette språket',
  fullPromptHelp:
    'Brukes i stedet for de felles instruksjonene når svaret er på dette språket. Hvert språk tjenesten svarer på må ha en.',
  fullPromptMissing: 'Dette språket mangler instruksjon.',
  fullPromptOffer:
    'Trenger språkene helt ulike instruksjoner? Da kan du skrive en hel instruksjon per språk i stedet for å bruke de felles.',
  writeSeparately: 'Skriv en egen instruksjon per språk',
  useShared: 'Bruk felles instruksjoner igjen',
  sharedUnused:
    'Tjenesten har en hel instruksjon per språk. Denne felles teksten brukes ikke før du velger felles instruksjoner igjen.',
});
