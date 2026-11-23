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
  attachmentsLabel: 'Vedlegg',
  attachmentLoading: 'Henter vedlegget …',
  attachmentFailed: 'Vedlegget kan ikke vises her. Du har kanskje ikke tilgang til kjøringen.',
  attachmentMeta: '{mediaType} · {size}',
  attachmentFromStep: 'fra steget {step}',
  attachmentImage: 'Bilde fra steget {step}',
  attachmentImagePlain: 'Bilde fra svaret',
  attachmentOpen: 'Last ned',
  bytes: '{n} byte',
  kilobytes: '{n} kB',
  megabytes: '{n} MB',
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
  hintForbidden:
    'Sjekk at tjenesten har tilgang til dokumentsamlingene og delene fra katalogen den bruker.',
  hintSmaller:
    'Prøv med mindre inndata, eller øk grensen for tjenesten under Begrensninger og loggføring.',
  hintDeadline: 'Prøv med mindre inndata, eller del jobben opp.',
  defaultTitle: 'Tjenesten feilet underveis.',
  stepFailed: 'Steget «{step}» feilet.',
  heading: 'Kjøringen feilet',
  technical: 'Teknisk melding',
  seeInLog: 'Se kjøringen i Logg',
  noAnswer: 'Vi fikk ikke svar fra modellen',
});

export const publish = defineNamespace({
  lockedByGate:
    'Publiser er låst fordi et krav til kvalitet ikke er oppfylt. Se forklaringen over.',
  publishedFirst: 'Utgave {next} er publisert og i bruk.',
  publishedNext:
    'Utgave {next} er publisert og i bruk. Du kan angre publiseringen under Historikk.',
  failed: 'Publiseringen feilet. Ingenting er endret. Prøv igjen.',
  publishedToTest: 'Utgave {next} er nå testutgaven. Den er ikke i bruk ennå.',
  updateAvailable: 'Oppdatering tilgjengelig',
  fromDigdir: 'Fra Digdir',
  updateIntro:
    'Digdir har gjort nye utgaver tilgjengelige. Tjenesten bytter ikke av seg selv. Testsettet ditt er kjørt med de nye utgavene.',
  testSet: 'Testsett {score}',
  include: 'Ta med i v{next}',
  changes: 'Endringer',
  firstVersion: 'Utgave {next}, første utgave',
  changedSince: 'Utgave {next}, endret siden utgave {current}',
  changedSinceInTest: 'Testutgave {next}, endret siden utgave {current}',
  updateFromDigdir: 'Oppdatering fra Digdir: {name}',
  gates: 'Krav til kvalitet',
  passed: 'Bestått',
  notPassed: 'Ikke bestått',
  cannotPublishYet: 'Kan ikke publiseres ennå',
  gatesNotMet: {
    one: '{failed} av {count} krav til kvalitet er ikke oppfylt. Kravet «{name}» er satt av {tenant} og kan ikke overstyres her.',
    other:
      '{failed} av {count} krav til kvalitet er ikke oppfylt. Kravet «{name}» er satt av {tenant} og kan ikke overstyres her.',
  },
  gatesNotMetTest: 'Du kan fortsatt publisere som testutgave.',
  reasonLabel: 'Hva er endret, og hvorfor?',
  reasonHelp: 'Påkrevd. Vises i Historikk og i Logg under Endringer.',
  previousStays:
    'Utgave {current} blir liggende. Du kan angre publiseringen når som helst under Historikk.',
  publish: 'Publiser',
  publishToTest: 'Publiser som testutgave',
  statusPublished: 'Utgave {next} er publisert.',
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
