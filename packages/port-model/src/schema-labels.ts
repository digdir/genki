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
  contextWindow: { label: 'Kontekstvindu (tokens)' },
  parameters: { label: 'Regler for parametere' },
  'parameters.temperature': { label: 'Temperatur' },
  'parameters.reasoning': { label: 'Resonnering' },
  'parameters.maxTokens': { label: 'Lengste svar (tokens)' },
  mode: { label: 'Regel', values: parameterModes },
  value: { label: 'Verdi' },
  tenants: { label: 'Virksomheter som kan bruke den', help: 'Tomt betyr alle.' },
  options: { label: 'Andre valg' },
  protocol: { label: 'Protokoll' },
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
  discovery: { label: 'Finn modeller automatisk' },
  'discovery.source': { label: 'Kilde' },
  'discovery.from': { label: 'Bruk oppslaget fra endepunktet' },
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
  contextWindow: { label: 'Context window (tokens)' },
  parameters: { label: 'Parameter rules' },
  'parameters.temperature': { label: 'Temperature' },
  'parameters.reasoning': { label: 'Reasoning' },
  'parameters.maxTokens': { label: 'Longest answer (tokens)' },
  mode: { label: 'Rule', values: parameterModesEn },
  value: { label: 'Value' },
  tenants: { label: 'Organisations that may use it', help: 'Empty means all.' },
  options: { label: 'Other options' },
  protocol: { label: 'Protocol' },
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
  discovery: { label: 'Find models automatically' },
  'discovery.source': { label: 'Source' },
  'discovery.from': { label: 'Use the lookup from the endpoint' },
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
