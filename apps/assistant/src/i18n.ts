import { defineCatalogue, type Translation } from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';

export const nb = defineCatalogue({
  host: {
    loading: 'Laster …',
    notFound: 'Her er det ingen assistent.',
    notFoundDetail: 'Adressen er ikke koblet til noen tjeneste i genki.',
    failed: 'Assistenten kunne ikke lastes. Prøv igjen om litt.',
    menu: 'Meny',
    home: 'Assistenten',
    signIn: 'Logg inn',
    signInTitle: 'Logg inn på Genki',
    signInLead: 'Logg inn med Ansattporten for å bruke {name}.',
    signInFailed: 'Innloggingen mislyktes. Prøv igjen.',
    signInUnavailable: 'Innlogging er ikke satt opp her.',
    signInUnavailableDetail: 'Du kan lese sidene under.',
    signOut: 'Logg ut',
    signedIn: 'Innlogget',
    noLayout: 'Tjenesten har ikke noe oppsett for assistenten.',
    pageMissing: 'Siden finnes ikke.',
    backTo: 'Tilbake til {name}',
  },
});

export const en = {
  host: {
    loading: 'Loading …',
    notFound: 'There is no assistant here.',
    notFoundDetail: 'This address is not linked to a service in genki.',
    failed: 'The assistant could not be loaded. Please try again shortly.',
    menu: 'Menu',
    home: 'The assistant',
    signIn: 'Log in',
    signInTitle: 'Log in to Genki',
    signInLead: 'Log in with Ansattporten to use {name}.',
    signInFailed: 'Logging in failed. Please try again.',
    signInUnavailable: 'Logging in is not set up here.',
    signInUnavailableDetail: 'You can read the pages below.',
    signOut: 'Log out',
    signedIn: 'Signed in',
    noLayout: 'The service has no layout for the assistant.',
    pageMissing: 'The page does not exist.',
    backTo: 'Back to {name}',
  },
} satisfies Translation<typeof nb>;

export const { useT } = defineTranslations({ nb, en });
