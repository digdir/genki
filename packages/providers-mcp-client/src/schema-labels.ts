import type { LabelText, SchemaLabels } from '@genai/contracts';

const nb = {
  protocol: {
    label: 'Protokoll',
    values: { mcp: 'MCP-server', a2a: 'A2A-agent', openapi: 'API med OpenAPI-beskrivelse' },
  },
  endpoint: { label: 'Adresse (URL)' },
  allow: { label: 'Tillatte verter' },
  'allow.host': { label: 'Vert' },
  'allow.port': { label: 'Port' },
  auth: { label: 'Pålogging' },
  'auth.kind': {
    label: 'Måte å logge på',
    values: {
      bearer: 'Bærertoken',
      header: 'Egen header',
      'oauth-client-credentials': 'OAuth med klient-ID og hemmelighet',
    },
  },
  secret: { label: 'Hemmelighet', help: 'En secret://-referanse, aldri selve nøkkelen.' },
  header: { label: 'Header' },
  tokenUrl: { label: 'Adresse for token' },
  clientId: { label: 'Klient-ID' },
  scope: { label: 'Scope' },
  timeoutMs: { label: 'Tidsavbrudd (millisekunder)' },
  maxResponseBytes: { label: 'Største svar (byte)' },
  document: { label: 'OpenAPI-beskrivelse' },
  documentUrl: { label: 'Adresse til OpenAPI-beskrivelsen' },
  operations: { label: 'Operasjoner som kan brukes' },
  writes: { label: 'Tillat operasjoner som endrer data' },
} satisfies Record<string, LabelText>;

const en: Record<keyof typeof nb, LabelText> = {
  protocol: {
    label: 'Protocol',
    values: { mcp: 'MCP server', a2a: 'A2A agent', openapi: 'API with an OpenAPI description' },
  },
  endpoint: { label: 'Address (URL)' },
  allow: { label: 'Allowed hosts' },
  'allow.host': { label: 'Host' },
  'allow.port': { label: 'Port' },
  auth: { label: 'Sign-in' },
  'auth.kind': {
    label: 'How to sign in',
    values: {
      bearer: 'Bearer token',
      header: 'Own header',
      'oauth-client-credentials': 'OAuth with client ID and secret',
    },
  },
  secret: { label: 'Secret', help: 'A secret:// reference, never the key itself.' },
  header: { label: 'Header' },
  tokenUrl: { label: 'Token address' },
  clientId: { label: 'Client ID' },
  scope: { label: 'Scope' },
  timeoutMs: { label: 'Timeout (milliseconds)' },
  maxResponseBytes: { label: 'Largest response (bytes)' },
  document: { label: 'OpenAPI description' },
  documentUrl: { label: 'Address of the OpenAPI description' },
  operations: { label: 'Operations that may be used' },
  writes: { label: 'Allow operations that change data' },
};

export const toolConnectionSchemaLabels: SchemaLabels = {
  nb,
  en,
  meta: {
    secret: { 'x-widget': 'secret', 'x-sensitive': true },
    document: { 'x-widget': 'code', 'x-advanced': true },
    tenant: { 'x-readOnly': true },
  },
};
