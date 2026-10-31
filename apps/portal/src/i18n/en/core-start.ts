import type { Translation } from '@genai/i18n';
import type { dataHandling as dataHandlingSource, start as startSource } from '../nb/core-start';

export const dataHandling = {
  title: 'How data is handled',
  storedHeading: 'What is stored',
  accessHeading: 'Who sees what',
  processingHeading: 'Where data is processed',
  loggedHeading: 'What is logged',
  markingHeading: 'Labelling of answers',
  undecidedHeading: 'Not decided yet',
  processingToday:
    'You can always see where each model processes data. Today the models run in Azure with global processing; models in Norway and the EU are coming.',
  loadingModels: 'Loading the models',
  noModels: 'No models are available to you yet.',
  modelsIntro: 'The models you can use, and where each of them processes data:',
  modelsLabel: 'Models and where they process data',
  modelAt: '{model}: {where}',
  residencyNorway: 'in Norway',
  residencyEu: 'in the EU/EEA',
  residencyGlobal: 'globally, including outside the EU/EEA',
  stored1:
    'Questions, answers, the sources the answer is based on and feedback are stored in the platform, in the EU/EEA.',
  stored2: 'The content is encrypted when it is stored.',
  stored3: 'The content is deleted when the content key is deleted.',
  access1: 'Administrators at the organisation see feedback in aggregate and without names.',
  access2:
    "Operators at Digdir see content only through a support session. The support session is time-limited, has a reason and is shown in the organisation's log.",
  access3:
    'In a support session Digdir can change the setup on behalf of the organisation. Each change is shown in the log as "Change from Digdir", with the name of the person who made it. Digdir never creates API keys for the organisation.',
  logged1: "Every run is recorded in the organisation's run log.",
  logged2: "The platform's operational logs do not contain questions or answers.",
  marking1: 'Answers from the platform are labelled "Answer made with AI" on screen.',
  marking2:
    'In API responses the answer is marked with the field ai_generated and the header genai-generated-by.',
  undecidedStorage: 'How long the content is stored',
  undecidedDpa: 'Data processing agreement',
  notDecidedYet: 'Not decided yet',
  accessWho: 'Who has access',
  storageTime: 'How long data is stored',
  storageTimeBody: 'Datasets are stored until the organisation deletes them.',
  storageTimePlaceholder:
    '[Placeholder: retention time for questions, answers and logs, and what happens to data when an organisation stops using the platform.]',
} satisfies Translation<typeof dataHandlingSource>;

export const start = {
  navOnPage: 'On this page',
  navShared: 'Shared services',
  navExamples: 'Examples',
  navPrice: 'Price and terms',
  navData: 'Data',
  navGetStarted: 'Get started',
  navDocs: 'Documentation',
  login: 'Sign in',
  loginFailed: 'Sign-in failed. Try again.',
  heroTitle: 'Generative AI for public organisations, run by Digdir',
  heroLead:
    'Build services that answer with sources, extract information from documents, write drafts and summarise. You decide what the services do. Digdir runs the platform, chooses which models are approved and builds in protection for personal data.',
  readDocs: 'Read the documentation',
  factWhoTitle: 'Who it is for',
  factWho: 'State and municipal organisations. You sign in with Ansattporten.',
  factWhereTitle: 'Where data is processed',
  factCostTitle: 'What it costs',
  factCost: 'You pay for what you use, measured in tokens. <link>See prices</link>',
  whatHeading: 'What the platform does',
  what1Title: 'You build your own services',
  what1Body:
    'Describe the job in your own words, and an assistant helps you set it up. A service can be started from a chat, from a case system, when a document arrives, on a schedule or as a batch job.',
  what2Title: 'Shared services are ready from day one',
  what2Body:
    'Plain language, Nynorsk, summaries, anonymisation, transcription and extraction of information. Use them as they are, or as building blocks in your own services.',
  what3Title: 'Protection is built in',
  what3Body:
    'Each service gets a risk level under the AI Act. Filtering of personal data, requirements for sources and approval by a person follow from the risk level. Every run is logged, so you can see how an answer came about.',
  sharedHeading: 'Shared services',
  sharedSub:
    'Digdir runs and tests these. All organisations can use them as soon as they have access.',
  shared1Title: 'Plain language',
  shared1Body: 'Rewrites text so it is easier to understand, without changing the content.',
  shared1Example: 'Used, for example, on decision letters before they are sent.',
  shared2Title: 'Bokmål to Nynorsk',
  shared2Body:
    'Translates text to Nynorsk and follows the spelling rules from the Language Council.',
  shared2Example: 'Used, for example, on web pages and forms.',
  shared3Title: 'Summaries',
  shared3Body:
    'Writes short summaries of long documents, with a reference to where in the text each point is.',
  shared3Example: 'Used, for example, on consultation responses and reports.',
  shared4Title: 'Anonymisation',
  shared4Body: 'Finds and removes names, national ID numbers, addresses and other personal data.',
  shared4Example: 'Used, for example, before documents are shared or published.',
  shared5Title: 'Transcription',
  shared5Body: 'Turns audio recordings into text in Bokmål or Nynorsk, with who is speaking.',
  shared5Example: 'Used, for example, for meetings and interviews.',
  shared6Title: 'Extract information',
  shared6Body:
    'Reads documents and fills in the fields you define, such as names, amounts and dates.',
  shared6Example: 'Used, for example, on applications and invoices.',
  examplesHeading: 'Three examples',
  examplesSub:
    'Imagined services in an imagined organisation, Testetaten, to show what is possible.',
  ex1Job: 'Answers',
  ex1Trigger: 'Chat',
  ex1Title: 'Ask the reports',
  ex1Body:
    'Employees ask questions on the intranet and get answers from evaluations in Kudos, with a link to the report and the page the answer is based on.',
  ex1In: 'A question',
  ex1Out: 'Answer with sources',
  ex2Job: 'Extracts data',
  ex2Trigger: 'When a document arrives',
  ex2Title: 'Read applications',
  ex2Body:
    'Whenever an application lands in the folder, the name, organisation number and amount are extracted and added to the case. Applications that lack attachments are flagged.',
  ex2In: 'PDF or Word',
  ex2Out: 'Fields in the case management system',
  ex3Job: 'Writes drafts',
  ex3Trigger: 'From a case system',
  ex3Title: 'Draft decision',
  ex3Body:
    'The caseworker presses a button in the case and gets a draft that refers to the regulations. Nothing is sent until the caseworker has approved the draft.',
  ex3In: 'The case and the attachments',
  ex3Out: 'Word document from a template',
  ex3Risk: 'High. Requires approval.',
  exIn: 'In',
  exOut: 'Out',
  exRunsIn: 'Runs in',
  exRunsInValue: 'Chosen per service',
  exRisk: 'Risk',
  priceHeading: 'Price',
  priceLead:
    'You pay for tokens, which are pieces of text the model reads and writes. A question with an answer and sources usually uses 3,000 to 6,000 tokens.',
  pricesNotDecided: 'Prices per model are not decided yet.',
  priceQuota:
    'Each organisation gets a quota per month, and can set its own limits per service. You can see usage and cost in the portal at all times.',
  termsHeading: 'Terms',
  term1: 'The terms are accepted by a person who can bind the organisation.',
  term2:
    'The organisation is the controller for the content of its own services. Digdir is the processor.',
  term3: 'The organisation assesses the risk level of each service under the AI Act.',
  term4: "Digdir gives at least 60 days' notice before a model is phased out.",
  howDataLink: 'How data is handled',
  dataNotAdopted:
    'The guidelines have not been adopted yet. Text marked "Not decided" is placeholder text.',
  dataReadMore: 'Read more about how data is handled',
  getStartedHeading: 'Get started',
  getStartedLead:
    'It usually takes a few working days (not decided) from request to first service.',
  step1Title: 'Request access',
  step1Body:
    'Sign in with Ansattporten and choose the organisation. Fill in the request and confirm that you have read the draft terms and data processing agreement. The terms are not decided yet.',
  step2Title: 'Digdir approves',
  step2Body:
    'Digdir processes the request and registers the organisation. You see the status in the portal, and sign in again when the request is approved.',
  step3Title: 'The first administrator signs in',
  step3Body:
    'The access manager at the organisation gives a person the right "Manage services" in Altinn. That person signs in to the portal.',
  step4Title: 'Build the first service',
  step4Body:
    'Try a shared service, or describe the job and let the assistant help you. Give colleagues access in Altinn when the service is ready.',
  sendRequest: 'Send request',
  docsHeading: 'Documentation',
  doc1Title: 'Introduction for managers',
  doc1Body: 'What the platform can be used for, and what the organisation must decide.',
  doc2Title: 'Guide to risk assessment',
  doc2Body: 'How to choose a risk level under the AI Act.',
  doc3Title: 'For developers',
  doc3Body: 'API, MCP and OpenAI-compatible endpoint, with examples.',
  doc4Title: 'Service status',
  doc4Body: 'Planned maintenance and ongoing incidents.',
  operatedBy: 'Operated by the Norwegian Digitalisation Agency',
  footer: 'Footer',
  privacy: 'Privacy statement',
  accessibility: 'Accessibility statement',
  contact: 'Contact',
} satisfies Translation<typeof startSource>;
