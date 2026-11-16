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
  kindNotInRegister: 'Not in the register',
} satisfies Translation<typeof source>;
