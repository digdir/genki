import {
  createTranslator,
  defineCatalogue,
  negotiate,
  type Locale,
  type Translation,
} from '@genai/i18n';

const nb = defineCatalogue({
  login: {
    header: 'Ansattporten (testmiljø)',
    badge: 'Testmiljø: ikke ekte innlogging',
    personTitle: 'Ansattporten - Velg testperson',
    personHeading: 'Velg testperson',
    personLead: 'Velg hvem du vil logge inn som.',
    nationalId: 'Fødselsnummer {pid}',
    organisationTitle: 'Ansattporten - Velg virksomhet',
    organisationHeading: 'Velg virksomhet du ønsker å representere',
    hello: 'Hei {name}',
    orgNumber: 'Org.nr. {orgno} ({unitType})',
    myself: 'Meg selv',
    myselfHint: 'Logg inn uten å representere en virksomhet',
    next: 'Neste',
    otherPerson: 'Velg en annen testperson',
    loggedOutTitle: 'Ansattporten - Logget ut',
    loggedOutHeading: 'Du er logget ut',
    loggedOutLead: 'Du kan lukke dette vinduet.',
  },
});

const en = {
  login: {
    header: 'Ansattporten (test environment)',
    badge: 'Test environment: not a real sign-in',
    personTitle: 'Ansattporten - Choose a test person',
    personHeading: 'Choose a test person',
    personLead: 'Choose who you want to sign in as.',
    nationalId: 'National identity number {pid}',
    organisationTitle: 'Ansattporten - Choose an organisation',
    organisationHeading: 'Choose the organisation you want to represent',
    hello: 'Hello {name}',
    orgNumber: 'Org. no. {orgno} ({unitType})',
    myself: 'Myself',
    myselfHint: 'Sign in without representing an organisation',
    next: 'Next',
    otherPerson: 'Choose another test person',
    loggedOutTitle: 'Ansattporten - Signed out',
    loggedOutHeading: 'You are signed out',
    loggedOutLead: 'You can close this window.',
  },
} satisfies Translation<typeof nb>;

export const loginCatalogues = { nb, en };

export const loginText = (locale: Locale) => createTranslator({ nb, en }, locale);

export const loginLocale = (uiLocales: string | undefined, acceptLanguage: string | undefined) =>
  negotiate(uiLocales) ?? negotiate(acceptLanguage) ?? 'nb';
