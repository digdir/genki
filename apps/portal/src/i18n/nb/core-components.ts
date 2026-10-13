import { defineNamespace } from '@genai/i18n';

export const components = defineNamespace({
  breadcrumbs: 'Brødsmuler',
  notAvailableTitle: 'Ikke tilgjengelig ennå',
  notDecided: 'Ikke bestemt',
  steps: 'Steg',
  stepDone: ' (fullført)',
  locationNorway: 'Data i Norge',
  locationEu: 'Data i EU/EØS',
  locationGlobal: 'Data utenfor EU/EØS',
  todayAt: 'i dag kl. {time}',
  changeLogged: 'Endret av {by} {when}: «{reason}». Logget.',
});

export const apiCall = defineNamespace({
  eyebrow: 'API-kall for «{action}»',
  notDecidedFor: 'Det finnes ikke et API for {what} ennå.',
  notDecidedNote: 'Kallet er et forslag i samme mønster som resten av API-et.',
  intro:
    'Dette er kallet knappen gjør, med verdiene du har valgt. Tokenet er tokenet ditt fra Ansattporten, og det vises ikke.',
  copyRequest: 'Kopier forespørselen',
  request: 'Forespørsel',
  rightRequired: 'Rettighet som kreves',
  replaceToken: 'Bytt ut $TOKEN med et eget token.',
  replaceReason: 'Bytt ut {placeholder} med en begrunnelse på minst 10 tegn, prosentkodet.',
  seeEndpoint: 'Se endepunktet i API-referansen',
});

export const runFailure = defineNamespace({
  hintMisconfigured: 'Rett oppsettet av steget i byggeren, og prøv igjen.',
  hintForbidden: 'Sjekk at tjenesten har tilgang til datasettene og byggeklossene den bruker.',
  hintSmaller: 'Prøv med mindre inndata, eller øk grensen for tjenesten under Innstillinger.',
  hintDeadline: 'Prøv med mindre inndata, eller del jobben opp.',
  defaultTitle: 'Tjenesten feilet underveis.',
  stepFailed: 'Steget «{step}» feilet.',
  heading: 'Kjøringen feilet',
  technical: 'Teknisk melding',
  seeInLog: 'Se kjøringen i Logg',
  noAnswer: 'Vi fikk ikke svar fra modellen',
});

export const publish = defineNamespace({
  lockedByGate: 'Publiser er låst fordi et kvalitetskrav ikke er oppfylt. Se forklaringen over.',
  publishedFirst: 'Versjon {next} er publisert og i bruk.',
  publishedNext:
    'Versjon {next} er publisert og i bruk. Versjon {current} kan gjenopprettes under Versjoner.',
  failed: 'Publiseringen feilet. Ingenting er endret. Prøv igjen.',
  publishedToTest: 'Versjon {next} er publisert til test. Den er bare tilgjengelig i testmiljøet.',
  updateAvailable: 'Oppdatering tilgjengelig',
  fromDigdir: 'Fra Digdir',
  updateIntro:
    'Digdir har gjort nye versjoner tilgjengelige. Tjenesten bytter ikke av seg selv. Testsettet ditt er kjørt med de nye versjonene.',
  testSet: 'Testsett {score}',
  include: 'Ta med i v{next}',
  changes: 'Endringer',
  firstVersion: 'Versjon {next}, første versjon',
  changedSince: 'Versjon {next}, endret siden versjon {current}',
  changedSinceInTest: 'Versjon {next} i test, endret siden versjon {current}',
  updateFromDigdir: 'Oppdatering fra Digdir: {name}',
  gates: 'Kvalitetskrav',
  passed: 'Bestått',
  notPassed: 'Ikke bestått',
  cannotPublishYet: 'Kan ikke publiseres ennå',
  gatesNotMet: {
    one: '{failed} av {count} kvalitetskrav er ikke oppfylt. Kravet «{name}» er satt av {tenant} og kan ikke overstyres her. Du kan fortsatt publisere til test.',
    other:
      '{failed} av {count} kvalitetskrav er ikke oppfylt. Kravet «{name}» er satt av {tenant} og kan ikke overstyres her. Du kan fortsatt publisere til test.',
  },
  reasonLabel: 'Hva er endret, og hvorfor?',
  reasonHelp: 'Påkrevd. Vises i versjonshistorikken og i Logg under Endringer.',
  previousStays:
    'Versjon {current} blir liggende. Du kan rulle tilbake til den når som helst under Versjoner.',
  publish: 'Publiser',
  publishToTest: 'Publiser til test',
  statusPublished: 'Versjon {next} er publisert.',
  statusLocked: 'Publiser er låst til alle krav er bestått.',
  statusAllPassed: 'Alle krav er bestått.',
});

export const resultTable = defineNamespace({
  result: 'Resultat',
  source: 'Kilde',
  sourceN: 'Kilde {n}: {name}',
  sources: 'Kilder',
  skipped: 'Hoppet over fordi de ikke kunne leses: {names}.',
  item: 'element {n}',
  download: 'Last ned CSV',
  fileName: 'tabell',
});
