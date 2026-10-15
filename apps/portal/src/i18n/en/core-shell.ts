import type { Translation } from '@genai/i18n';
import type { app as appSource, shell as shellSource } from '../nb/core-shell';

export const shell = {
  navOverview: 'Overview',
  navServices: 'Services',
  navSharedServices: 'Shared services',
  navDatasets: 'Datasets',
  navBuildingBlocks: 'Building blocks',
  navPlayground: 'Playground',
  navAccess: 'Access',
  navUsage: 'Usage',
  navIntegrations: 'Integrations',
  navLog: 'Log',
  navSettings: 'Settings',
  skipToContent: 'Skip to main content',
  menu: 'Menu',
  mainMenu: 'Main menu',
  brandShort: 'AI portal',
  brandFull: 'Generative AI platform',
  owner: 'Digdir',
  lockdown: 'Locked test environment: here, only registered clients use models and run ingestion.',
  orgMeta: 'Org. no. {orgNr}',
  orgMetaUnregistered: 'Org. no. {orgNr} · not registered',
  orgButton: 'Acting for {name}, org. no. {orgNr}. Switch organisation',
  orgButtonUnregistered: 'Acting for {name}, org. no. {orgNr}, not registered. Switch organisation',
  actingForLabel: 'Acting for',
  chooseOrg: 'Choose organisation',
  chooseOrgHelp: 'You can act for these organisations.',
  organisations: 'Organisations',
  orgOptionMeta: 'Org. no. {orgNr}',
  orgOptionUnregistered: 'Org. no. {orgNr} · not registered',
  orgOptionRole: 'Org. no. {orgNr} · {role}',
  userMenuButton: '{name}, open user menu',
  userMenu: 'User menu',
  actingFor: 'Acting for {name} (org. no. {orgNr})',
  yourRights: 'Your rights',
  rightsGivenBy: 'The rights are granted by the access managers at your organisation, in Altinn.',
  seeInAltinn: 'View or change in Altinn (opens in a new tab)',
  logout: 'Log out',
  guide: 'User guide',
  status: 'Service status',
  contact: 'Contact Digdir',
  badgeIngest: {
    one: '{count} ingestion needs follow-up',
    other: '{count} ingestions need follow-up',
  },
} satisfies Translation<typeof shellSource>;

export const app = {
  notFound: 'Page not found',
  notDrawn: 'This page has not been designed yet. Go back to <link>Overview</link>.',
  guideIntro:
    'In the portal, your organisation sets up AI services and keeps an eye on them. This is how the pages fit together.',
  guideStartTitle: 'Get started',
  guideStart:
    '<overview>Overview</overview> shows the services, datasets and ingests of the organisation you act for. You switch organisation at the top of the page.',
  guideBuildTitle: 'Set up a service',
  guideBuild:
    'Create and publish services under <services>Services</services>, add knowledge under <datasets>Datasets</datasets>, and reuse parts from <blocks>Building blocks</blocks>. Services Digdir shares with everyone are under <shared>Shared services</shared>.',
  guideTryTitle: 'Try it and put it to use',
  guideTry:
    'Try a service in the <playground>Playground</playground>. Call it from your own system with the examples in <code>Call a service from code</code> and the endpoints in the <api>API reference</api>.',
  guideFollowTitle: 'Follow up and control',
  guideFollow:
    'See use and cost in <usage>Usage</usage>, runs in the <log>Log</log>, who has access in <access>Access</access>, and defaults for the organisation in <settings>Settings</settings>.',
  guideRights:
    'What you can do depends on the rights your organisation has given you in Altinn. You see them in the user menu.',
  statusIntro: 'This page asks the platform API whether it answers.',
  statusChecking: 'Checking the API',
  statusApi: 'API',
  statusUp: 'Answering',
  statusDown: 'The API does not answer right now. Try again in a little while.',
  statusVersion: 'Version',
  statusCheckAgain: 'Check again',
  statusScope:
    'This page only shows whether the API answers. You see the status of each service under <services>Services</services>, and failed runs in the <log>Log</log>.',
  contactOwner:
    'The platform is owned and developed by the Norwegian Digitalisation Agency (Digdir). The source code is in the genki repository.',
  contactText:
    'The platform is being piloted and has no support contact point of its own yet. Get in touch with your contact person at Digdir.',
  loadingStrategies: 'Loading the ways of working from the platform',
  signedOutTitle: 'You are signed out',
  sessionExpired: 'Your session has expired. Sign in again to continue.',
  sessionEnding:
    'Your session ends at {time}. Sign in again now and we will fill in what you have written.',
  sessionRelogin: 'Sign in again',
  login: 'Sign in',
  unknownUser: 'Unknown user',
  languageReason: 'Changed the language in the user menu',
} satisfies Translation<typeof appSource>;
