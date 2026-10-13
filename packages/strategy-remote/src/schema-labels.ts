import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  endpoint: { label: 'Ekstern motor' },
  'endpoint.url': { label: 'Adresse (URL)' },
  'endpoint.protocol': { label: 'Protokoll', values: { http: 'HTTP', a2a: 'A2A' } },
  'endpoint.residency': {
    label: 'Hvor data behandles',
    values: { norway: 'Norge', eu: 'EU/EØS', global: 'Globalt' },
  },
  auth: { label: 'Pålogging' },
  'auth.kind': {
    label: 'Måte å logge på',
    values: { bearer: 'Bærertoken', header: 'Egen header' },
  },
  secret: { label: 'Hemmelighet', help: 'En secret://tenant/-referanse, aldri selve nøkkelen.' },
  header: { label: 'Header' },
  timeoutMs: { label: 'Tidsavbrudd (millisekunder)' },
  maxResponseBytes: { label: 'Største svar (byte)' },
  agent: { label: 'Registrert motor' },
  send: { label: 'Hva som sendes til motoren' },
  'send.history': { label: 'Samtalehistorikk' },
  'send.maxMessages': { label: 'Flest meldinger i historikken' },
  'send.identity': {
    label: 'Hvem som spør',
    values: { none: 'Ikke send', subject: 'Send en anonym ID' },
  },
  'send.metadata': { label: 'Metadata som sendes med' },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  endpoint: { label: 'External engine' },
  'endpoint.url': { label: 'Address (URL)' },
  'endpoint.protocol': { label: 'Protocol', values: { http: 'HTTP', a2a: 'A2A' } },
  'endpoint.residency': {
    label: 'Where data is processed',
    values: { norway: 'Norway', eu: 'EU/EEA', global: 'Global' },
  },
  auth: { label: 'Sign-in' },
  'auth.kind': {
    label: 'How to sign in',
    values: { bearer: 'Bearer token', header: 'Own header' },
  },
  secret: { label: 'Secret', help: 'A secret://tenant/ reference, never the key itself.' },
  header: { label: 'Header' },
  timeoutMs: { label: 'Timeout (milliseconds)' },
  maxResponseBytes: { label: 'Largest response (bytes)' },
  agent: { label: 'Registered engine' },
  send: { label: 'What is sent to the engine' },
  'send.history': { label: 'Conversation history' },
  'send.maxMessages': { label: 'Most messages in the history' },
  'send.identity': {
    label: 'Who is asking',
    values: { none: 'Do not send', subject: 'Send an anonymous ID' },
  },
  'send.metadata': { label: 'Metadata sent along' },
};

export const remoteAgentSchemaLabels: SchemaLabels = {
  nb,
  en,
  meta: {
    secret: { 'x-widget': 'secret', 'x-sensitive': true },
    timeoutMs: { 'x-advanced': true },
    maxResponseBytes: { 'x-advanced': true },
  },
  titles: { 'remote-agent': { nb: 'Egen motor', en: 'Own engine' } },
};
