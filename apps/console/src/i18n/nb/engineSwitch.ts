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
  activate: 'Ta i bruk',
  retry: 'Prøv igjen',
  cancel: 'Avbryt flyttingen',
  keptUntil: '{endpoint} beholdes til {date}, så flyttingen kan rulles tilbake.',
  rollback: 'Rull tilbake til {endpoint}',
  failed: 'Plattformen avviste endringen. Prøv igjen.',
});
