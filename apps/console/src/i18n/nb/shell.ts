import { defineNamespace } from '@genai/i18n';

export const shell = defineNamespace({
  groupPlatform: 'Plattform',
  pageAtlas: 'Systematlas',
  skipLink: 'Hopp til hovedinnhold',
  menu: 'Meny',
  menuLabel: 'Konsollmeny',
  title: 'Driftskonsoll',
  lockdownReadOnly:
    'Låst testplattform: du kan se deg rundt, men endringer, modeller og innlesing krever innlogging med Entra ID.',
  envLocal: 'Lokalt',
  envProduction: 'Produksjon',
  logout: 'Logg ut',
  checkingLogin: 'Sjekker innloggingen',
  loggedOutTitle: 'Du er logget ut',
  loggedOutText: 'Økten din er utløpt. Logg inn igjen for å fortsette der du var.',
  retryAfterFailure: '{message} Prøv igjen.',
  login: 'Logg inn',
  loginIntro: 'For Digdirs driftsteam. Logg inn med Digdir-kontoen din.',
  loginWithAccount: 'Logg inn med Digdir-konto',
  refusedTitle: 'Du har ikke tilgang til driftskonsollet',
  refusedText:
    'Du er logget inn som {name}. Driftskonsollet er bare for Digdirs driftsteam. Kontoen din mangler driftsrollen.',
  refusedNotOperator:
    'Driftskonsollet er bare for Digdirs driftsteam. Kontoen du logget inn med, mangler driftsrollen.',
  refusedHelp: 'Trenger du tilgang, kan lederen din be om driftsrollen for deg.',
  notFound: 'Fant ikke siden',
  notFoundHelp: 'Sjekk adressen, eller gå til Virksomheter.',
});
