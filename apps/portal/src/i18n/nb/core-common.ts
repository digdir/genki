import { defineNamespace } from '@genai/i18n';

export const common = defineNamespace({
  cancel: 'Avbryt',
  save: 'Lagre',
  close: 'Lukk',
  tryAgain: 'Prøv igjen',
  loading: 'Henter …',
  back: 'Tilbake',
  next: 'Neste',
  previous: 'Forrige',
  edit: 'Endre',
  add: 'Legg til',
  remove: 'Fjern',
  delete: 'Slett',
  copy: 'Kopier',
  copied: 'Kopiert',
  yes: 'Ja',
  no: 'Nei',
  search: 'Søk',
  open: 'Åpne',
  apiCall: 'Vis API-kall',
  reason: 'Begrunnelse',
  reasonTooShort: 'Skriv en begrunnelse på minst {min} tegn.',
  needsRight: 'Du trenger rettigheten «{right}».',
  notPriced: 'Ikke priset',
  actorOperator: 'Digdir',
  actorEmployee: 'Ansatt i virksomheten',
  actorPlatform: 'Plattformen',
  seconds: '{value} s',
  ore: '{value} øre',
  unknown: 'Ukjent',
});

export const rights = defineNamespace({
  useServices: 'Bruke tjenester',
  manageServices: 'Administrere tjenester',
  manageDatasets: 'Administrere datasett',
  registerBuildingBlocks: 'Registrere byggeklosser',
  viewUsage: 'Se forbruk og kostnad',
  read: 'Lese',
  write: 'Skrive',
});

export const taskStatus = defineNamespace({
  queued: 'I kø',
  running: 'Kjører',
  interrupted: 'Venter på godkjenning',
  completed: 'Fullført',
  failed: 'Feilet',
  cancelled: 'Avbrutt',
});
