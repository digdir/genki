import { defineNamespace } from '@genai/i18n';

export const stateRegister = defineNamespace({
  title: 'Statens organisering',
  intro:
    'Hvilket departement hver statlig virksomhet ligger under, slik departementene har registrert det i Enhetsregisteret. Statsregnskapet fra DFØ kontrollerer registeret hver måned.',
  loading: 'Henter registeret',
  never: 'aldri',
  summary: 'Sist lest {date}: {units} enheter. Sist endret {changed}.',
  stale:
    'Registeret er ikke lest de siste {nights} nettene. Svarene bygger på registeret fra {date}.',
  accounts: 'Statsregnskapet for {period}: {same} virksomheter ligger under samme departement.',
  noAccounts: 'Statsregnskapet er ikke lest ennå.',
  noneTitle: 'Ingen forskjeller',
  noneText: 'Statsregnskapet fører alle virksomhetene under samme departement som registeret.',
  tableLabel: 'Forskjeller mellom registeret og statsregnskapet',
  colAgency: 'Virksomhet',
  colRegister: 'I Enhetsregisteret',
  colAccounts: 'I statsregnskapet',
  colKind: 'Hva det er',
  kindMismatch: 'Avvik',
  kindBudgetBooking: 'Budsjettføring',
  kindNotInRegister: 'Uten departement i registeret',
  creditBefore: 'Inneholder data under ',
  creditLicence: 'norsk lisens for offentlige data (NLOD)',
  creditLicenceUrl: 'https://data.norge.no/nlod/no/2.0',
  creditBy: ' tilgjengeliggjort av ',
  creditRegister: 'Brønnøysundregistrene',
  creditAnd: ' og ',
  creditAccounts: 'Direktoratet for forvaltning og økonomistyring (DFØ)',
  creditAfter: '.',
});
