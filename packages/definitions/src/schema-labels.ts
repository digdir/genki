import type { LabelText, PropertyMeta, SchemaLabels } from '@genai/contracts';

type Texts = Record<string, LabelText>;

const prefixed = <T>(prefix: string, entries: Record<string, T>) =>
  Object.fromEntries(Object.entries(entries).map(([key, value]) => [`${prefix}.${key}`, value]));

const models = { route: '/tenants/{tenant}/catalog?kind=model', items: 'data', value: 'id' };
const datasets = { route: '/tenants/{tenant}/catalog?kind=dataset', items: 'data', value: 'id' };
const rerankers = { route: '/tenants/{tenant}/catalog?kind=reranker', items: 'data', value: 'id' };
const tools = { route: '/tenants/{tenant}/skill-tools', items: 'data', value: 'id' };
const skills = { route: '/tenants/{tenant}/skills', items: 'data', value: 'id' };
const blocks = { route: '/tenants/{tenant}/step-flows/blocks', items: 'blocks', value: 'ref' };

const inputFieldNb = {
  id: { label: 'ID', help: 'Liten forbokstav, så bokstaver, tall eller _.' },
  label: { label: 'Ledetekst' },
  kind: {
    label: 'Felttype',
    values: {
      text: 'Tekst',
      'long-text': 'Lang tekst',
      choice: 'Ett valg',
      'multi-choice': 'Flere valg',
      number: 'Tall',
      year: 'Årstall',
      date: 'Dato',
      organisation: 'Virksomhet',
    },
  },
  required: { label: 'Må fylles ut' },
  help: { label: 'Hjelpetekst' },
  options: { label: 'Valg' },
  optionsFrom: { label: 'Valg fra et datasett' },
  'optionsFrom.dataset': { label: 'Datasett' },
  'optionsFrom.facet': { label: 'Felt i datasettet' },
  'optionsFrom.min': { label: 'Minste verdi' },
  'optionsFrom.max': { label: 'Største verdi' },
  'optionsFrom.pattern': { label: 'Mønster (regulært uttrykk)' },
  default: { label: 'Standardverdi' },
  dependsOn: { label: 'Avhenger av feltet' },
} satisfies Texts;

const inputFieldEn: Record<keyof typeof inputFieldNb, LabelText> = {
  id: { label: 'ID', help: 'A lowercase letter, then letters, digits or _.' },
  label: { label: 'Label' },
  kind: {
    label: 'Field type',
    values: {
      text: 'Text',
      'long-text': 'Long text',
      choice: 'One choice',
      'multi-choice': 'Several choices',
      number: 'Number',
      year: 'Year',
      date: 'Date',
      organisation: 'Organisation',
    },
  },
  required: { label: 'Required' },
  help: { label: 'Help text' },
  options: { label: 'Choices' },
  optionsFrom: { label: 'Choices from a dataset' },
  'optionsFrom.dataset': { label: 'Dataset' },
  'optionsFrom.facet': { label: 'Field in the dataset' },
  'optionsFrom.min': { label: 'Lowest value' },
  'optionsFrom.max': { label: 'Highest value' },
  'optionsFrom.pattern': { label: 'Pattern (regular expression)' },
  default: { label: 'Default value' },
  dependsOn: { label: 'Depends on the field' },
};

const inputFieldMeta: Record<string, PropertyMeta> = {
  help: { 'x-widget': 'textarea' },
  'optionsFrom.dataset': { 'x-widget': 'dataset', 'x-options': datasets },
  default: { 'x-widget': 'text' },
};

const outputNb = {
  kind: {
    label: 'Type resultat',
    values: {
      answer: 'Svar som tekst',
      fields: 'Felter',
      document: 'Dokument fra en mal',
      table: 'Tabell',
    },
  },
  fields: { label: 'Felter i resultatet' },
  'fields.name': { label: 'Navn' },
  'fields.label': { label: 'Visningsnavn' },
  'fields.type': {
    label: 'Type',
    values: { string: 'Tekst', number: 'Tall', boolean: 'Ja/nei', date: 'Dato', list: 'Liste' },
  },
  'fields.description': { label: 'Beskrivelse' },
  'fields.required': { label: 'Påkrevd' },
  columns: { label: 'Kolonner' },
  'columns.key': { label: 'Nøkkel' },
  'columns.name': { label: 'Navn' },
  'columns.type': {
    label: 'Type',
    values: { string: 'Tekst', number: 'Tall', enum: 'Faste verdier' },
  },
  'columns.description': { label: 'Beskrivelse' },
  'columns.kind': {
    label: 'Hvor verdien kommer fra',
    values: { document: 'Fra dokumentet', assessment: 'Vurdering' },
  },
  'columns.values': { label: 'Tillatte verdier' },
  rowKey: { label: 'Kolonnen som skiller radene' },
  withSources: { label: 'Vis kilder' },
  template: { label: 'Mal' },
} satisfies Texts;

const outputEn: Record<keyof typeof outputNb, LabelText> = {
  kind: {
    label: 'Kind of result',
    values: {
      answer: 'Answer as text',
      fields: 'Fields',
      document: 'Document from a template',
      table: 'Table',
    },
  },
  fields: { label: 'Result fields' },
  'fields.name': { label: 'Name' },
  'fields.label': { label: 'Display name' },
  'fields.type': {
    label: 'Type',
    values: { string: 'Text', number: 'Number', boolean: 'Yes/no', date: 'Date', list: 'List' },
  },
  'fields.description': { label: 'Description' },
  'fields.required': { label: 'Required' },
  columns: { label: 'Columns' },
  'columns.key': { label: 'Key' },
  'columns.name': { label: 'Name' },
  'columns.type': {
    label: 'Type',
    values: { string: 'Text', number: 'Number', enum: 'Fixed values' },
  },
  'columns.description': { label: 'Description' },
  'columns.kind': {
    label: 'Where the value comes from',
    values: { document: 'From the document', assessment: 'Assessment' },
  },
  'columns.values': { label: 'Allowed values' },
  rowKey: { label: 'Column that tells rows apart' },
  withSources: { label: 'Show sources' },
  template: { label: 'Template' },
};

const outputMeta: Record<string, PropertyMeta> = {
  'fields.description': { 'x-widget': 'textarea' },
  fields: { 'x-showIf': { field: 'kind', equals: 'fields' } },
  columns: { 'x-showIf': { field: 'kind', equals: 'table' } },
  rowKey: { 'x-showIf': { field: 'kind', equals: 'table' }, 'x-advanced': true },
  template: { 'x-widget': 'textarea', 'x-showIf': { field: 'kind', equals: 'document' } },
};

const triggerNb = {
  kind: {
    label: 'Hva starter tjenesten',
    values: {
      schedule: 'Etter tidsplan',
      'queue-message': 'Melding i kø',
      'document-arrives': 'Når et dokument kommer inn',
    },
  },
  cron: { label: 'Tidsplan (cron)', help: 'For eksempel 0 7 * * 1-5 for hverdager kl. 07.00.' },
  queue: { label: 'Kø' },
  folder: { label: 'Mappe' },
} satisfies Texts;

const triggerEn: Record<keyof typeof triggerNb, LabelText> = {
  kind: {
    label: 'What starts the service',
    values: {
      schedule: 'On a schedule',
      'queue-message': 'Message on a queue',
      'document-arrives': 'When a document arrives',
    },
  },
  cron: { label: 'Schedule (cron)', help: 'For example 0 7 * * 1-5 for weekdays at 07:00.' },
  queue: { label: 'Queue' },
  folder: { label: 'Folder' },
};

const triggerMeta: Record<string, PropertyMeta> = { cron: { 'x-widget': 'cron' } };

const group = (nb: string, en: string): PropertyMeta => ({ 'x-group': { nb, en } });

const common = {
  nb: {
    apiVersion: { label: 'API-versjon' },
    kind: { label: 'Type' },
    metadata: { label: 'Om definisjonen' },
    spec: { label: 'Oppsett' },
    tenant: { label: 'Virksomhet (organisasjonsnummer)' },
    id: { label: 'ID' },
    name: { label: 'Navn' },
    version: { label: 'Versjon' },
    title: { label: 'Tittel' },
    nb: { label: 'Bokmål' },
    en: { label: 'Engelsk' },
    description: { label: 'Beskrivelse' },
    input: { label: 'Inndata' },
    tools: { label: 'Verktøy' },
    dataset: { label: 'Datasett' },
  } satisfies Texts,
  en: {
    apiVersion: { label: 'API version' },
    kind: { label: 'Kind' },
    metadata: { label: 'About the definition' },
    spec: { label: 'Setup' },
    tenant: { label: 'Organisation (organisation number)' },
    id: { label: 'ID' },
    name: { label: 'Name' },
    version: { label: 'Version' },
    title: { label: 'Title' },
    nb: { label: 'Norwegian Bokmål' },
    en: { label: 'English' },
    description: { label: 'Description' },
    input: { label: 'Input' },
    tools: { label: 'Tools' },
    dataset: { label: 'Dataset' },
  },
};

const serviceNb = {
  'metadata.id': { label: 'ID', help: 'Små bokstaver, tall og bindestrek.' },
  'spec.purpose': {
    label: 'Formål',
    help: 'Én eller to setninger om hva tjenesten gjør og for hvem.',
  },
  'spec.exampleQuestions': {
    label: 'Eksempelspørsmål',
    help: 'Opptil seks spørsmål som vises til dem som bruker tjenesten.',
  },
  'spec.audience': {
    label: 'Hvem er tjenesten for?',
    values: { employees: 'Ansatte i virksomheten', public: 'Innbyggere og næringsliv' },
  },
  'spec.riskClass': {
    label: 'Risikonivå etter KI-forordningen',
    values: { minimal: 'Minimal risiko', limited: 'Begrenset risiko', high: 'Høy risiko' },
  },
  'spec.riskConfirmation': { label: 'Bekreftelse av risikonivået' },
  'spec.riskConfirmation.by': { label: 'Bekreftet av' },
  'spec.riskConfirmation.at': { label: 'Bekreftet' },
  'spec.riskConfirmation.reasons': { label: 'Begrunnelser' },
  'spec.riskConfirmation.riskClass': {
    label: 'Bekreftet risikonivå',
    values: { minimal: 'Minimal risiko', limited: 'Begrenset risiko', high: 'Høy risiko' },
  },
  'spec.variants': { label: 'Varianter' },
  'spec.variants.id': { label: 'ID for varianten' },
  'spec.variants.publicName': { label: 'Offentlig navn' },
  'spec.variants.model': { label: 'Modell for varianten' },
  'spec.variants.strategy': { label: 'Arbeidsmåte for varianten' },
  'spec.variants.chat': { label: 'Vises i chat' },
  'spec.variants.aliases': { label: 'Andre navn' },
  'spec.variants.overrides': { label: 'Overstyringer' },
  'spec.variants.filters': { label: 'Faste søkefiltre' },
  'spec.variants.filters.fields': { label: 'Filterfelter' },
  'spec.variants.filters.fields.field': { label: 'Felt' },
  'spec.variants.filters.fields.type': {
    label: 'Filtertype',
    values: { multiselect: 'Er en av', contains: 'Inneholder', 'not-in-set': 'Er ingen av' },
  },
  'spec.variants.filters.fields.value-type': {
    label: 'Verditype',
    values: { string: 'Tekst', integer: 'Heltall' },
  },
  'spec.variants.filters.fields.selected-options': { label: 'Verdier' },
  'spec.languages': {
    label: 'Språk tjenesten svarer på',
    values: { nb: 'Bokmål', nn: 'Nynorsk', en: 'Engelsk' },
  },
  'spec.input': { label: 'Hva går inn?' },
  'spec.input.accepts': { label: 'Filtyper som tas imot' },
  'spec.input.ocr': { label: 'Les tekst i bilder (OCR)' },
  'spec.input.fields': { label: 'Skjemafelt' },
  ...prefixed('spec.input.fields', inputFieldNb),
  'spec.output': { label: 'Hva kommer ut?' },
  ...prefixed('spec.output', outputNb),
  strategy: { label: 'Arbeidsmåte' },
  'strategy.id': {
    label: 'Arbeidsmåte',
    values: {
      'single-call': 'Ett steg',
      'agent-loop': 'Agent (søker selv)',
      'rag-single-shot': 'Ett søk og ett svar',
      'step-flow': 'Fast stegflyt',
      'remote-agent': 'Egen motor',
    },
  },
  'strategy.version': { label: 'Versjon av arbeidsmåten' },
  'strategy.config': { label: 'Oppsett for arbeidsmåten' },
  'spec.knowledge': { label: 'Kunnskap' },
  'spec.knowledge.datasets': { label: 'Datasett' },
  'spec.knowledge.datasets.filters': { label: 'Filter' },
  'spec.knowledge.runtimeDocuments': { label: 'Dokumenter ved kjøring' },
  'spec.knowledge.retrieval': { label: 'Søkeoppsett' },
  'spec.knowledge.reranker': { label: 'Omrangering' },
  'spec.tools.use': { label: 'Verktøy' },
  'spec.skills': { label: 'Ferdigheter' },
  'spec.model': { label: 'Modell' },
  'spec.model.primary': { label: 'Hovedmodell' },
  'spec.model.fallback': { label: 'Reservemodell' },
  'spec.model.roles': { label: 'Modell per rolle' },
  'spec.model.roles.synthesis': { label: 'Modell som skriver svaret' },
  'spec.model.roles.planner': { label: 'Modell som planlegger søket' },
  'spec.model.roles.judge': { label: 'Modell som vurderer' },
  'spec.model.residency': {
    label: 'Hvor data behandles',
    values: { norway: 'Norge', eu: 'EU/EØS', global: 'Globalt' },
  },
  'spec.guardrails': { label: 'Vern' },
  'spec.settings': { label: 'Innstillinger' },
  'spec.callOverrides': { label: 'Innstillinger som kan overstyres per kall' },
  'spec.callOverrides.mcp': { label: 'MCP' },
  'spec.callOverrides.openai': { label: 'OpenAI-kompatibelt API' },
  'spec.callOverrides.rest': { label: 'API' },
  'spec.callOverrides.a2a': { label: 'A2A-agent' },
  'spec.exposure': { label: 'Kanaler' },
  'spec.exposure.chat': { label: 'KI-arbeidsflaten (plattformens chat)' },
  'spec.exposure.mcp': { label: 'MCP' },
  'spec.exposure.openai': { label: 'OpenAI-kompatibelt API' },
  'spec.exposure.rest': { label: 'API' },
  'spec.exposure.a2a': { label: 'A2A-agent' },
  'spec.exposure.a2aPublicCard': { label: 'Offentlig A2A-kort' },
  'spec.availableTo': {
    label: 'Tilgjengelig for',
    help: '* for alle, eller en liste med organisasjonsnumre.',
  },
  'spec.triggers': { label: 'Utløsere' },
  ...prefixed('spec.triggers', triggerNb),
  'spec.batch': { label: 'Samlet jobb' },
  'spec.batch.enabled': { label: 'Kan kjøres over et datasett eller en mappe' },
  'spec.evaluation': { label: 'Evaluering' },
  'spec.evaluation.testSets': { label: 'Testsett' },
  'spec.evaluation.gates': { label: 'Krav før publisering' },
  'spec.improve': { label: 'Forbedring' },
  'spec.improve.allow': {
    label: 'Hva assistenten kan foreslå å forbedre',
    values: {
      instructions: 'Instruksjoner',
      examples: 'Eksempler',
      retrieval: 'Søk',
      model: 'Modell',
    },
  },
} satisfies Texts;

const serviceEn: Record<keyof typeof serviceNb, LabelText> = {
  'metadata.id': { label: 'ID', help: 'Lowercase letters, digits and dashes.' },
  'spec.purpose': {
    label: 'Purpose',
    help: 'One or two sentences on what the service does and for whom.',
  },
  'spec.exampleQuestions': {
    label: 'Example questions',
    help: 'Up to six questions shown to the people who use the service.',
  },
  'spec.audience': {
    label: 'Who is the service for?',
    values: { employees: 'Employees of the organisation', public: 'Citizens and businesses' },
  },
  'spec.riskClass': {
    label: 'Risk level under the AI Act',
    values: { minimal: 'Minimal risk', limited: 'Limited risk', high: 'High risk' },
  },
  'spec.riskConfirmation': { label: 'Confirmation of the risk level' },
  'spec.riskConfirmation.by': { label: 'Confirmed by' },
  'spec.riskConfirmation.at': { label: 'Confirmed' },
  'spec.riskConfirmation.reasons': { label: 'Reasons' },
  'spec.riskConfirmation.riskClass': {
    label: 'Confirmed risk level',
    values: { minimal: 'Minimal risk', limited: 'Limited risk', high: 'High risk' },
  },
  'spec.variants': { label: 'Variants' },
  'spec.variants.id': { label: 'Variant ID' },
  'spec.variants.publicName': { label: 'Public name' },
  'spec.variants.model': { label: 'Model for the variant' },
  'spec.variants.strategy': { label: 'Way of working for the variant' },
  'spec.variants.chat': { label: 'Shown in chat' },
  'spec.variants.aliases': { label: 'Other names' },
  'spec.variants.overrides': { label: 'Overrides' },
  'spec.variants.filters': { label: 'Fixed search filters' },
  'spec.variants.filters.fields': { label: 'Filter fields' },
  'spec.variants.filters.fields.field': { label: 'Field' },
  'spec.variants.filters.fields.type': {
    label: 'Filter type',
    values: { multiselect: 'Is one of', contains: 'Contains', 'not-in-set': 'Is none of' },
  },
  'spec.variants.filters.fields.value-type': {
    label: 'Value type',
    values: { string: 'Text', integer: 'Integer' },
  },
  'spec.variants.filters.fields.selected-options': { label: 'Values' },
  'spec.languages': {
    label: 'Languages the service answers in',
    values: { nb: 'Norwegian Bokmål', nn: 'Norwegian Nynorsk', en: 'English' },
  },
  'spec.input': { label: 'What goes in?' },
  'spec.input.accepts': { label: 'Accepted file types' },
  'spec.input.ocr': { label: 'Read text in images (OCR)' },
  'spec.input.fields': { label: 'Form fields' },
  ...(prefixed('spec.input.fields', inputFieldEn) as Record<string, LabelText>),
  'spec.output': { label: 'What comes out?' },
  ...(prefixed('spec.output', outputEn) as Record<string, LabelText>),
  strategy: { label: 'Way of working' },
  'strategy.id': {
    label: 'Way of working',
    values: {
      'single-call': 'One step',
      'agent-loop': 'Agent (searches by itself)',
      'rag-single-shot': 'One search and one answer',
      'step-flow': 'Fixed step flow',
      'remote-agent': 'Own engine',
    },
  },
  'strategy.version': { label: 'Version of the way of working' },
  'strategy.config': { label: 'Setup for the way of working' },
  'spec.knowledge': { label: 'Knowledge' },
  'spec.knowledge.datasets': { label: 'Datasets' },
  'spec.knowledge.datasets.filters': { label: 'Filters' },
  'spec.knowledge.runtimeDocuments': { label: 'Documents at run time' },
  'spec.knowledge.retrieval': { label: 'Search setup' },
  'spec.knowledge.reranker': { label: 'Reranking' },
  'spec.tools.use': { label: 'Tool' },
  'spec.skills': { label: 'Skills' },
  'spec.model': { label: 'Model' },
  'spec.model.primary': { label: 'Main model' },
  'spec.model.fallback': { label: 'Fallback model' },
  'spec.model.roles': { label: 'Model per role' },
  'spec.model.roles.synthesis': { label: 'Model that writes the answer' },
  'spec.model.roles.planner': { label: 'Model that plans the search' },
  'spec.model.roles.judge': { label: 'Model that judges' },
  'spec.model.residency': {
    label: 'Where data is processed',
    values: { norway: 'Norway', eu: 'EU/EEA', global: 'Global' },
  },
  'spec.guardrails': { label: 'Guardrails' },
  'spec.settings': { label: 'Settings' },
  'spec.callOverrides': { label: 'Settings a call may override' },
  'spec.callOverrides.mcp': { label: 'MCP' },
  'spec.callOverrides.openai': { label: 'OpenAI-compatible API' },
  'spec.callOverrides.rest': { label: 'API' },
  'spec.callOverrides.a2a': { label: 'A2A agent' },
  'spec.exposure': { label: 'Channels' },
  'spec.exposure.chat': { label: 'The AI workspace (the platform chat)' },
  'spec.exposure.mcp': { label: 'MCP' },
  'spec.exposure.openai': { label: 'OpenAI-compatible API' },
  'spec.exposure.rest': { label: 'API' },
  'spec.exposure.a2a': { label: 'A2A agent' },
  'spec.exposure.a2aPublicCard': { label: 'Public A2A card' },
  'spec.availableTo': {
    label: 'Available to',
    help: '* for everyone, or a list of organisation numbers.',
  },
  'spec.triggers': { label: 'Triggers' },
  ...(prefixed('spec.triggers', triggerEn) as Record<string, LabelText>),
  'spec.batch': { label: 'Batch run' },
  'spec.batch.enabled': { label: 'Can run over a dataset or a folder' },
  'spec.evaluation': { label: 'Evaluation' },
  'spec.evaluation.testSets': { label: 'Test sets' },
  'spec.evaluation.gates': { label: 'Gates before publishing' },
  'spec.improve': { label: 'Improvement' },
  'spec.improve.allow': {
    label: 'What the assistant may suggest improving',
    values: {
      instructions: 'Instructions',
      examples: 'Examples',
      retrieval: 'Search',
      model: 'Model',
    },
  },
};

const purpose = group('Formål og målgruppe', 'Purpose and audience');
const io = group('Inn og ut', 'Input and output');
const knowledge = group('Kunnskap', 'Knowledge');
const toolsGroup = group('Verktøy', 'Tools');
const how = group('Arbeidsmåte', 'Way of working');
const model = group('Modell', 'Model');
const guards = group('Vern', 'Guardrails');
const start = group('Start og kanaler', 'Start and channels');
const advanced: PropertyMeta = { ...group('Avansert', 'Advanced'), 'x-advanced': true };

const serviceMeta: Record<string, PropertyMeta> = {
  'spec.purpose': { ...purpose, 'x-order': 1, 'x-widget': 'textarea' },
  'spec.exampleQuestions': { ...purpose, 'x-order': 2 },
  'spec.audience': { ...purpose, 'x-order': 3 },
  'spec.riskClass': { ...purpose, 'x-order': 4 },
  'spec.riskConfirmation': { ...purpose, 'x-order': 5, 'x-readOnly': true },
  'spec.languages': { ...purpose, 'x-order': 6 },
  'spec.input': { ...io, 'x-order': 10 },
  'spec.output': { ...io, 'x-order': 11 },
  ...prefixed('spec.input.fields', inputFieldMeta),
  ...prefixed('spec.output', outputMeta),
  ...prefixed('spec.triggers', triggerMeta),
  'spec.knowledge': { ...knowledge, 'x-order': 20 },
  'spec.knowledge.datasets.dataset': { 'x-widget': 'dataset', 'x-options': datasets },
  'spec.knowledge.reranker': { 'x-widget': 'select', 'x-options': rerankers },
  'spec.knowledge.retrieval': { 'x-advanced': true },
  'spec.tools': { ...toolsGroup, 'x-order': 30, 'x-widget': 'tool', 'x-options': tools },
  'spec.tools.use': { 'x-widget': 'tool', 'x-options': tools },
  'spec.skills': { ...toolsGroup, 'x-order': 31, 'x-widget': 'multiselect', 'x-options': skills },
  'spec.strategy': { ...how, 'x-order': 40 },
  'spec.variants': { ...how, 'x-order': 41, 'x-advanced': true },
  'strategy.config': { 'x-widget': 'code' },
  'spec.model': { ...model, 'x-order': 50 },
  'spec.model.primary': { 'x-widget': 'model', 'x-options': models },
  'spec.model.fallback': { 'x-widget': 'model', 'x-options': models },
  'spec.model.roles.synthesis': { 'x-widget': 'model', 'x-options': models },
  'spec.model.roles.planner': { 'x-widget': 'model', 'x-options': models },
  'spec.model.roles.judge': { 'x-widget': 'model', 'x-options': models },
  'spec.variants.model': { 'x-widget': 'model', 'x-options': models },
  'spec.guardrails': { ...guards, 'x-order': 60 },
  'spec.exposure': { ...start, 'x-order': 70 },
  'spec.triggers': { ...start, 'x-order': 71 },
  'spec.batch': { ...start, 'x-order': 72 },
  'spec.callOverrides': { ...advanced, 'x-order': 80 },
  'spec.settings': { ...advanced, 'x-order': 81 },
  'spec.evaluation': { ...advanced, 'x-order': 82 },
  'spec.improve': { ...advanced, 'x-order': 83 },
  'spec.availableTo': { ...start, 'x-order': 73, 'x-operator': true, 'x-widget': 'list' },
  'strategy.id': { 'x-widget': 'select' },
};

const flowNb = {
  'spec.purpose': { label: 'Formål' },
  'spec.input': { label: 'Inndata til flyten' },
  steps: { label: 'Steg' },
  block: { label: 'Byggekloss' },
  params: { label: 'Parametere' },
  onError: {
    label: 'Ved feil',
    values: { stop: 'Stopp', skip: 'Hopp over steget', 'use-default': 'Bruk standardverdien' },
  },
  default: { label: 'Standardverdi' },
  repeat: { label: 'Gjenta' },
  'repeat.until': { label: 'Gjenta til', help: 'Et uttrykk som avslutter gjentakelsen.' },
  'repeat.max': { label: 'Flest runder' },
  forEach: { label: 'For hvert element' },
  'forEach.in': { label: 'Listen' },
  'forEach.as': { label: 'Navn på elementet' },
  switchOn: { label: 'Velg vei ut fra' },
  cases: { label: 'Veier' },
  'cases.when': { label: 'Når verdien er' },
  else: { label: 'Ellers' },
  subflow: { label: 'Delflyt' },
  'spec.recipe': {
    label: 'Oppskrift',
    help: 'Fyll ut for å tilby flyten som en ferdig arbeidsmåte med enkle innstillinger.',
  },
  'spec.recipe.summary': { label: 'Velg denne når' },
  'spec.settings': {
    label: 'Innstillinger',
    help: 'Enkle innstillinger en variant fyller ut. Stegene leser dem som settings.<navn>.',
  },
  'spec.settings.type': { label: 'Type' },
  'spec.settings.properties': { label: 'Innstillingene' },
  'spec.settings.properties.type': { label: 'Type verdi' },
  'spec.settings.properties.x-label': { label: 'Navn som vises' },
  'spec.settings.properties.x-help': { label: 'Hjelpetekst' },
  'spec.settings.properties.x-widget': { label: 'Felttype' },
  'spec.settings.properties.x-options': { label: 'Valg' },
  'spec.settings.properties.x-options.route': { label: 'Adresse valgene hentes fra' },
  'spec.settings.properties.x-options.value': { label: 'Feltet med verdien' },
  'spec.settings.properties.x-options.label': { label: 'Feltet med navnet' },
  'spec.settings.properties.x-options.items': { label: 'Listen i svaret' },
  'spec.settings.properties.x-enumLabels': { label: 'Navn på verdiene' },
  'spec.settings.properties.x-order': { label: 'Rekkefølge' },
  'spec.settings.properties.x-advanced': { label: 'Avansert' },
  'spec.settings.properties.enum': { label: 'Tillatte verdier' },
  'spec.settings.properties.items': { label: 'Elementene i listen' },
  'spec.settings.properties.items.type': { label: 'Type element' },
  'spec.settings.properties.items.enum': { label: 'Tillatte elementer' },
  'spec.settings.properties.minimum': { label: 'Minste verdi' },
  'spec.settings.properties.maximum': { label: 'Største verdi' },
  'spec.settings.properties.minItems': { label: 'Færrest elementer' },
  'spec.settings.properties.maxItems': { label: 'Flest elementer' },
  'spec.settings.properties.maxLength': { label: 'Lengste tekst' },
  'spec.settings.required': { label: 'Påkrevde innstillinger' },
} satisfies Texts;

const flowEn: Record<keyof typeof flowNb, LabelText> = {
  'spec.purpose': { label: 'Purpose' },
  'spec.input': { label: 'Flow input' },
  steps: { label: 'Steps' },
  block: { label: 'Building block' },
  params: { label: 'Parameters' },
  onError: {
    label: 'On error',
    values: { stop: 'Stop', skip: 'Skip the step', 'use-default': 'Use the default value' },
  },
  default: { label: 'Default value' },
  repeat: { label: 'Repeat' },
  'repeat.until': { label: 'Repeat until', help: 'An expression that ends the repetition.' },
  'repeat.max': { label: 'Most rounds' },
  forEach: { label: 'For each item' },
  'forEach.in': { label: 'The list' },
  'forEach.as': { label: 'Name of the item' },
  switchOn: { label: 'Choose a path by' },
  cases: { label: 'Paths' },
  'cases.when': { label: 'When the value is' },
  else: { label: 'Otherwise' },
  subflow: { label: 'Subflow' },
  'spec.recipe': {
    label: 'Recipe',
    help: 'Fill in to offer the flow as a ready-made way of working with plain settings.',
  },
  'spec.recipe.summary': { label: 'Pick this when' },
  'spec.settings': {
    label: 'Settings',
    help: 'Plain settings a variant fills in. The steps read them as settings.<name>.',
  },
  'spec.settings.type': { label: 'Type' },
  'spec.settings.properties': { label: 'The settings' },
  'spec.settings.properties.type': { label: 'Value type' },
  'spec.settings.properties.x-label': { label: 'Label shown' },
  'spec.settings.properties.x-help': { label: 'Help text' },
  'spec.settings.properties.x-widget': { label: 'Field type' },
  'spec.settings.properties.x-options': { label: 'Choices' },
  'spec.settings.properties.x-options.route': { label: 'Address the choices come from' },
  'spec.settings.properties.x-options.value': { label: 'Field with the value' },
  'spec.settings.properties.x-options.label': { label: 'Field with the name' },
  'spec.settings.properties.x-options.items': { label: 'List in the response' },
  'spec.settings.properties.x-enumLabels': { label: 'Names of the values' },
  'spec.settings.properties.x-order': { label: 'Order' },
  'spec.settings.properties.x-advanced': { label: 'Advanced' },
  'spec.settings.properties.enum': { label: 'Allowed values' },
  'spec.settings.properties.items': { label: 'Items in the list' },
  'spec.settings.properties.items.type': { label: 'Item type' },
  'spec.settings.properties.items.enum': { label: 'Allowed items' },
  'spec.settings.properties.minimum': { label: 'Lowest value' },
  'spec.settings.properties.maximum': { label: 'Highest value' },
  'spec.settings.properties.minItems': { label: 'Fewest items' },
  'spec.settings.properties.maxItems': { label: 'Most items' },
  'spec.settings.properties.maxLength': { label: 'Longest text' },
  'spec.settings.required': { label: 'Required settings' },
};

const flowMeta: Record<string, PropertyMeta> = {
  'spec.purpose': { 'x-widget': 'textarea' },
  'spec.settings': { 'x-widget': 'code', 'x-advanced': true },
  block: { 'x-widget': 'select', 'x-options': blocks },
  params: { 'x-widget': 'code' },
  input: { 'x-widget': 'code' },
  default: { 'x-widget': 'code' },
  'cases.when': { 'x-widget': 'code' },
};

const skillNb = {
  'spec.description': { label: 'Beskrivelse' },
  'spec.instructions': { label: 'Instruksjoner' },
  'spec.examples': { label: 'Eksempler' },
  'spec.examples.input': { label: 'Inndata' },
  'spec.examples.expectedOutput': { label: 'Forventet svar' },
  'spec.attachments': { label: 'Vedlegg' },
  'spec.attachments.blob': { label: 'Fil' },
  'spec.testset': { label: 'Testsett' },
  'spec.testset.passThreshold': {
    label: 'Krav for å bestå',
    help: 'Andel testtilfeller som må bestå, fra 0 til 1.',
  },
  'spec.testset.cases': { label: 'Testtilfeller' },
  'spec.testset.cases.input': { label: 'Inndata' },
  'spec.testset.cases.expected': { label: 'Forventet' },
  'spec.testset.cases.type': {
    label: 'Type test',
    values: { criteria: 'Kriterier', fields: 'Felter', must_reject: 'Skal avvises' },
  },
  'spec.testset.cases.context': { label: 'Kontekst' },
  'spec.testset.cases.dataset': { label: 'Datasett' },
} satisfies Texts;

const skillEn: Record<keyof typeof skillNb, LabelText> = {
  'spec.description': { label: 'Description' },
  'spec.instructions': { label: 'Instructions' },
  'spec.examples': { label: 'Examples' },
  'spec.examples.input': { label: 'Input' },
  'spec.examples.expectedOutput': { label: 'Expected answer' },
  'spec.attachments': { label: 'Attachments' },
  'spec.attachments.blob': { label: 'File' },
  'spec.testset': { label: 'Test set' },
  'spec.testset.passThreshold': {
    label: 'Pass threshold',
    help: 'Share of test cases that must pass, from 0 to 1.',
  },
  'spec.testset.cases': { label: 'Test cases' },
  'spec.testset.cases.input': { label: 'Input' },
  'spec.testset.cases.expected': { label: 'Expected' },
  'spec.testset.cases.type': {
    label: 'Test type',
    values: { criteria: 'Criteria', fields: 'Fields', must_reject: 'Must be rejected' },
  },
  'spec.testset.cases.context': { label: 'Context' },
  'spec.testset.cases.dataset': { label: 'Dataset' },
};

const skillMeta: Record<string, PropertyMeta> = {
  'spec.description': { 'x-widget': 'textarea' },
  'spec.instructions': { 'x-widget': 'prompt' },
  'spec.tools': { 'x-widget': 'tool', 'x-options': tools },
  'spec.testset.cases.dataset': { 'x-widget': 'dataset', 'x-options': datasets },
  'spec.testset.cases.expected': { 'x-widget': 'code' },
};

export const commonSchemaLabels: SchemaLabels = {
  ...common,
  meta: {
    '$.apiVersion': { 'x-readOnly': true },
    '$.kind': { 'x-readOnly': true },
    '$.metadata.tenant': { 'x-readOnly': true },
    '$.metadata.version': { 'x-readOnly': true },
  },
};

export const serviceSchemaLabels: SchemaLabels = {
  nb: serviceNb,
  en: serviceEn,
  meta: serviceMeta,
};

export const stepFlowSchemaLabels: SchemaLabels = { nb: flowNb, en: flowEn, meta: flowMeta };

export const skillSchemaLabels: SchemaLabels = { nb: skillNb, en: skillEn, meta: skillMeta };

export const inputFieldSchemaLabels: SchemaLabels = {
  nb: inputFieldNb,
  en: inputFieldEn,
  meta: inputFieldMeta,
};

export const outputSchemaLabels: SchemaLabels = { nb: outputNb, en: outputEn, meta: outputMeta };

export const triggerSchemaLabels: SchemaLabels = {
  nb: triggerNb,
  en: triggerEn,
  meta: triggerMeta,
};
