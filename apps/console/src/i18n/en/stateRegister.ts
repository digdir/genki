import type { Translation } from '@genai/i18n';
import type { stateRegister as source } from '../nb/stateRegister';

export const stateRegister = {
  title: "The state's organisation",
  intro:
    'Which ministry each state agency is under, as the ministries have registered it in Enhetsregisteret. The state accounts from DFØ check the register every month.',
  loading: 'Loading the register',
  never: 'never',
  summary: 'Last read {date}: {units} units. Last changed {changed}.',
  stale:
    'The register has not been read for the last {nights} nights. Answers rest on the register from {date}.',
  accounts: 'State accounts for {period}: {same} agencies are under the same ministry.',
  noAccounts: 'The state accounts have not been read yet.',
  noneTitle: 'No differences',
  noneText: 'The state accounts book every agency under the same ministry as the register.',
  tableLabel: 'Differences between the register and the state accounts',
  colAgency: 'Agency',
  colRegister: 'In Enhetsregisteret',
  colAccounts: 'In the state accounts',
  colKind: 'What it is',
  kindMismatch: 'Mismatch',
  kindBudgetBooking: 'Budget booking',
  kindNotInRegister: 'No ministry in the register',
  creditBefore: 'Contains data under the ',
  creditLicence: 'Norwegian licence for Open Government data (NLOD)',
  creditLicenceUrl: 'https://data.norge.no/nlod/en/2.0',
  creditBy: ' distributed by ',
  creditRegister: 'Brønnøysundregistrene',
  creditAnd: ' and ',
  creditAccounts: 'the Norwegian Agency for Public and Financial Management (DFØ)',
  creditAfter: '.',
} satisfies Translation<typeof source>;
