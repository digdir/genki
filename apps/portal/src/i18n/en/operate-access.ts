import type { Translation } from '@genai/i18n';
import type { accessArea as source } from '../nb/operate-access';

const access = {
  title: 'Access',
  lead: 'Rights in the portal are granted in Altinn by the access manager in {tenant}.',
  grant: 'Give a colleague access',
  newTab: '(opens in a new tab)',
  openAltinn: 'Open Altinn',
  tabsLabel: 'Access',
  tabPeople: 'People',
  tabServices: 'Services',
  altinnErrorTitle: 'Could not reach Altinn',
  altinnErrorStale:
    'We are showing the rights as they were {at}. Changes made in Altinn after that are not shown yet.',
  rightUseDesc:
    'Can use the services the organisation has taken into use, in chat or from their own systems.',
  rightServicesDesc: 'Can create, change, test and publish services.',
  rightDatasetsDesc: 'Can add sources, upload files and ingest again.',
  rightUsageDesc: 'Can see token usage, cost and quota for the organisation.',
  searchPerson: 'Search for a person',
  showWhoCan: 'Show those who can',
  filterAll: 'All',
  noRights: 'No rights',
  showing: 'Showing {shown} of {total} people',
  noMatch: 'No people match the search',
  resetFilter: 'Reset search and filter',
  detailServices: 'Can use these services',
  detailSource: 'Where the rights come from',
  allServices: 'All the services. Access cannot be limited per service yet.',
  needsUseRight: 'None. Needs «{right}» in Altinn.',
  missingRight: 'Lacks «{right}»',
  yourRights: 'Your rights',
  youHaveNoRights: 'You have no rights in the portal.',
  colleaguesInAltinn:
    'The portal does not fetch your colleagues’ rights from Altinn yet. See who has which rights in Altinn.',
  servicesLead: 'Everyone with «{right}» can use all the services.',
  serviceKeysLead:
    'Systems call a service with an API key bound to it. The keys are made and revoked under Channels and frontends on the service, and every change is logged.',
  serviceKeys: {
    one: '1 API key is bound to the service',
    other: '{count} API keys are bound to the service',
  },
  loadingServices: 'Fetching the services',
  noServicesTitle: 'No services yet',
  noServicesText: 'The services you publish are shown here.',
  dialogWho: 'Who should get access?',
  dialogWhat: 'What should your colleague be able to do?',
  dialogInAltinn: 'This right is granted in Altinn by your access manager. Send this message:',
  dialogPickOne: 'Choose at least one thing above, and we will write the message.',
  messageLabel: 'The message to the access manager',
  colleague: 'a colleague',
  message: {
    one: 'Hi!\nCould you give {name} the right {rights} for genki in Altinn, on behalf of {tenant} (org. no. {org})?\n\nBest regards, {sender}',
    other:
      'Hi!\nCould you give {name} the rights {rights} for genki in Altinn, on behalf of {tenant} (org. no. {org})?\n\nBest regards, {sender}',
  },
  copyMessage: 'Copy the message',
  copied: 'Copied. Paste the message into an email or a Teams chat to the access manager.',
  copyFailed: 'Could not copy. Select the text and copy it yourself.',
  discardAsk: 'Discard what you have written?',
  discard: 'Discard',
  keepWriting: 'Keep writing',
};

export const accessArea = { access } satisfies Translation<typeof source>;
