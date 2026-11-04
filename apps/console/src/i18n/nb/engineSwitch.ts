import { defineNamespace } from '@genai/i18n';

export const engineSwitch = defineNamespace({
  title: 'Søkemotor',
  loading: 'Henter søkemotoren',
  current: 'Søkemotor nå: {endpoint}',
  move: 'Flytt til kunnskapsdatabasen',
  target: 'Til søkemotor',
  reingestNote:
    'Datasettet leses inn på nytt fra kilden. Tjenestene søker i den gamle søkemotoren til du tar den nye i bruk.',
  start: 'Start flyttingen',
  close: 'Lukk',
  noTargets:
    'Det finnes ingen søkemotor i kunnskapsdatabasen ennå. Lag en under Søkemotorer, med tilkoblingen Kunnskapsserveren.',
  route: 'Fra {from} til {to}',
  stateRunning: 'Leser inn',
  stateFailed: 'Innlesingen feilet',
  stateComparing: 'Sammenligner søkene',
  stateReady: 'Klar til å tas i bruk',
  stateActivating: 'Tas i bruk',
  stateActive: 'I bruk',
  stateRolledBack: 'Rullet tilbake',
  stateCancelled: 'Avbrutt',
  progress: '{percent} % ({documents} dokumenter)',
  generation: 'Generasjon {generation}',
  failedDocuments: {
    one: '{count} dokument kunne ikke leses inn',
    other: '{count} dokumenter kunne ikke leses inn',
  },
  estimate:
    'Innlesing på nytt: {costMin}–{costMax} kr, {minutesMin}–{minutesMax} min ({documents} dokumenter)',
  notAvailable: 'Flyttingen kan ikke startes.',
  loadingEstimate: 'Regner ut kostnad og tid',
  noEstimate: 'Fikk ikke regnet ut hva flyttingen koster. Prøv igjen.',
  comparison: 'Treff blant de fem første: {from} {before} %, {to} {after} % ({cases} spørsmål)',
  worse: 'Den nye søkemotoren treffer dårligere. Begrunnelsen må ha minst {min} tegn.',
  errorLead: 'Innlesingen stoppet. Feilmeldingen fra plattformen:',
  activate: 'Ta i bruk',
  retry: 'Prøv igjen',
  cancel: 'Avbryt flyttingen',
  keptUntil: '{endpoint} beholdes til {date}, så flyttingen kan rulles tilbake.',
  rollback: 'Rull tilbake til {endpoint}',
  failed: 'Plattformen avviste endringen. Prøv igjen.',
});
