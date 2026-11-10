import type { LabelText, SchemaLabels } from '@genai/contracts';

const prompt = { 'x-widget': 'prompt' } as const;

const instructionsNb = {
  instructions: {
    label: 'Instruksjoner',
    help: 'Én tekst for alle språk, eller én per språk.',
  },
  languageInstructions: {
    label: 'Tillegg per språk',
    help: 'Legges til instruksjonene når svaret skal være på dette språket.',
  },
  nb: { label: 'Bokmål' },
  nn: { label: 'Nynorsk' },
  en: { label: 'Engelsk' },
} satisfies Record<string, LabelText>;

const instructionsEn: Record<keyof typeof instructionsNb, LabelText> = {
  instructions: {
    label: 'Instructions',
    help: 'One text for every language, or one per language.',
  },
  languageInstructions: {
    label: 'Additions per language',
    help: 'Added to the instructions when the answer is in this language.',
  },
  nb: { label: 'Norwegian Bokmål' },
  nn: { label: 'Norwegian Nynorsk' },
  en: { label: 'English' },
};

export const instructionSchemaLabels: SchemaLabels = {
  nb: instructionsNb,
  en: instructionsEn,
  meta: {
    instructions: prompt,
    'instructions.nb': prompt,
    'instructions.nn': prompt,
    'instructions.en': prompt,
    'languageInstructions.nb': prompt,
    'languageInstructions.nn': prompt,
    'languageInstructions.en': prompt,
  },
};

const parameterModes = { unsupported: 'Støttes ikke', fixed: 'Fast verdi' };
const parameterModesEn = { unsupported: 'Not supported', fixed: 'Fixed value' };

const nb = {
  id: { label: 'ID' },
  endpoint: { label: 'Endepunkt' },
  deployment: { label: 'Utrulling hos leverandøren' },
  family: { label: 'Modellfamilie' },
  residency: {
    label: 'Hvor data behandles',
    values: { norway: 'Norge', eu: 'EU/EØS', global: 'Globalt' },
  },
  capabilities: {
    label: 'Egenskaper',
    values: {
      stream: 'Strømmer svaret',
      tools: 'Kan bruke verktøy',
      'json-schema': 'Svarer etter skjema',
      reasoning: 'Resonnerer',
    },
  },
  apis: {
    label: 'API per operasjon',
    help: 'Hvilket API utrullingen bruker for hver operasjon, for eksempel samtale. Uten verdi samtale med tilkoblingens standard-API.',
  },
  contextWindow: { label: 'Kontekstvindu (tokens)' },
  maxOutputTokens: { label: 'Mest svar modellen kan gi (tokens)' },
  parameters: { label: 'Regler for parametere' },
  'parameters.temperature': { label: 'Temperatur' },
  'parameters.reasoning': { label: 'Resonnering' },
  'parameters.maxTokens': { label: 'Lengste svar (tokens)' },
  mode: { label: 'Regel', values: parameterModes },
  value: { label: 'Verdi' },
  tenants: { label: 'Virksomheter som kan bruke den', help: 'Tomt betyr alle.' },
  embed: { label: 'Innbygging' },
  dimensions: { label: 'Dimensjoner' },
  maxBatch: { label: 'Flest tekster per kall' },
  rerank: { label: 'Omrangering' },
  onFailure: {
    label: 'Når omrangeringen feiler',
    values: { degrade: 'Behold rekkefølgen fra søket', fail: 'Avbryt' },
  },
  options: { label: 'Andre valg' },
  protocol: { label: 'Protokoll' },
  families: {
    label: 'API-familier',
    help: 'API-familiene tilkoblingen tilbyr, med stien under adressen eller en full adresse for hver.',
  },
  baseURL: { label: 'Adresse (URL)' },
  auth: { label: 'Pålogging' },
  'auth.kind': {
    label: 'Måte å logge på',
    values: {
      'api-key': 'API-nøkkel',
      bearer: 'Bærertoken',
      'token-provider': 'Tokenleverandør',
      header: 'Egen header',
    },
  },
  secret: { label: 'Hemmelighet', help: 'En secret://-referanse, aldri selve nøkkelen.' },
  header: { label: 'Header' },
  provider: { label: 'Tokenleverandør' },
  allowedHosts: {
    label: 'Tillatte verter for svarlenker',
    help: 'Verter utenom endepunktets egen som en lenke i et svar kan føre til. Bare en operatør setter dem.',
  },
  settings: {
    label: 'Innstillinger',
    help: 'Verdier som ikke er hemmelige, som en nøkkel-ID. En beskrivelse leser dem i headere og spørringen, aldri i adressen eller stien. Bare en operatør setter dem.',
  },
  keys: {
    label: 'Flere nøkler',
    help: 'Navngitte hemmeligheter som bare en signeringsmodul kan bruke. De sendes aldri med en forespørsel.',
  },
  discovery: { label: 'Finn modeller automatisk' },
  'discovery.source': { label: 'Kilde' },
  'discovery.from': { label: 'Bruk oppslaget fra endepunktet' },
  'discovery.idPrefix': {
    label: 'Starten på ID-en',
    help: 'Modellene som finnes får ID-en <start>/<utrulling>. Uten verdi tilkoblingens ID.',
  },
  'discovery.apis': { label: 'API per operasjon for modellene som finnes' },
  'discovery.include': { label: 'Ta med' },
  'discovery.exclude': { label: 'Utelat' },
  'discovery.capabilities': {
    label: 'Egenskaper for modellene som finnes',
    values: {
      stream: 'Strømmer svaret',
      tools: 'Kan bruke verktøy',
      'json-schema': 'Svarer etter skjema',
      reasoning: 'Resonnerer',
    },
  },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  id: { label: 'ID' },
  endpoint: { label: 'Endpoint' },
  deployment: { label: 'Deployment at the provider' },
  family: { label: 'Model family' },
  residency: {
    label: 'Where data is processed',
    values: { norway: 'Norway', eu: 'EU/EEA', global: 'Global' },
  },
  capabilities: {
    label: 'Capabilities',
    values: {
      stream: 'Streams the answer',
      tools: 'Can use tools',
      'json-schema': 'Answers by a schema',
      reasoning: 'Reasons',
    },
  },
  apis: {
    label: 'API per operation',
    help: "Which API the deployment uses for each operation, such as chat. Without a value, chat with the connection's default API.",
  },
  contextWindow: { label: 'Context window (tokens)' },
  maxOutputTokens: { label: 'Most output the model can give (tokens)' },
  parameters: { label: 'Parameter rules' },
  'parameters.temperature': { label: 'Temperature' },
  'parameters.reasoning': { label: 'Reasoning' },
  'parameters.maxTokens': { label: 'Longest answer (tokens)' },
  mode: { label: 'Rule', values: parameterModesEn },
  value: { label: 'Value' },
  tenants: { label: 'Organisations that may use it', help: 'Empty means all.' },
  embed: { label: 'Embedding' },
  dimensions: { label: 'Dimensions' },
  maxBatch: { label: 'Most texts per call' },
  rerank: { label: 'Reranking' },
  onFailure: {
    label: 'When reranking fails',
    values: { degrade: 'Keep the search order', fail: 'Stop' },
  },
  options: { label: 'Other options' },
  protocol: { label: 'Protocol' },
  families: {
    label: 'API families',
    help: 'The API families the connection offers, each with its path under the address or a full address.',
  },
  baseURL: { label: 'Address (URL)' },
  auth: { label: 'Sign-in' },
  'auth.kind': {
    label: 'How to sign in',
    values: {
      'api-key': 'API key',
      bearer: 'Bearer token',
      'token-provider': 'Token provider',
      header: 'Own header',
    },
  },
  secret: { label: 'Secret', help: 'A secret:// reference, never the key itself.' },
  header: { label: 'Header' },
  provider: { label: 'Token provider' },
  allowedHosts: {
    label: 'Allowed hosts for answer links',
    help: "Hosts besides the endpoint's own that a link in an answer may lead to. Only an operator sets them.",
  },
  settings: {
    label: 'Settings',
    help: 'Values that are not secret, such as a key id. A descriptor reads them in headers and the query, never in the address or the path. Only an operator sets them.',
  },
  keys: {
    label: 'More keys',
    help: 'Named secrets that only a signing module can use. They are never sent with a request.',
  },
  discovery: { label: 'Find models automatically' },
  'discovery.source': { label: 'Source' },
  'discovery.from': { label: 'Use the lookup from the endpoint' },
  'discovery.idPrefix': {
    label: 'Start of the id',
    help: "Models found get the id <start>/<deployment>. Without a value, the connection's id.",
  },
  'discovery.apis': { label: 'API per operation for the models found' },
  'discovery.include': { label: 'Include' },
  'discovery.exclude': { label: 'Leave out' },
  'discovery.capabilities': {
    label: 'Capabilities of the models found',
    values: {
      stream: 'Streams the answer',
      tools: 'Can use tools',
      'json-schema': 'Answers by a schema',
      reasoning: 'Reasons',
    },
  },
};

export const modelCatalogSchemaLabels: SchemaLabels = {
  nb,
  en,
  meta: {
    secret: { 'x-widget': 'secret', 'x-sensitive': true },
    options: { 'x-widget': 'code', 'x-advanced': true },
    parameters: { 'x-advanced': true },
    value: { 'x-widget': 'text' },
  },
};
