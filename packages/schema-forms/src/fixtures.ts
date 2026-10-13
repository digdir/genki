import type { SchemaRef, SchemaUse, UiSchema } from './schema.js';

const t = (nb: string, en: string) => ({ nb, en });

const rule = (label: { nb: string; en: string }, order: number, value: UiSchema): UiSchema => ({
  'x-label': label,
  'x-order': order,
  oneOf: [
    {
      type: 'object',
      required: ['mode'],
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          const: 'unsupported',
          'x-label': t('Regel', 'Rule'),
          'x-enumLabels': {
            unsupported: t('Støttes ikke, send aldri', 'Not supported, never send'),
          },
        },
      },
    },
    {
      type: 'object',
      required: ['mode', 'value'],
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          const: 'fixed',
          'x-label': t('Regel', 'Rule'),
          'x-enumLabels': { fixed: t('Fast verdi', 'Fixed value') },
        },
        value: { ...value, 'x-label': t('Fast verdi', 'Fixed value') },
      },
    },
  ],
});

export const fixtureSchemas: Record<string, UiSchema> = {
  'Service@v1': {
    type: 'object',
    required: ['name', 'model'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        'x-label': t('Navn', 'Name'),
        'x-group': t('Om tjenesten', 'About the service'),
        'x-order': 1,
        'x-right': 'service.change',
      },
      description: {
        type: 'string',
        'x-label': t('Beskrivelse', 'Description'),
        'x-widget': 'textarea',
        'x-group': t('Om tjenesten', 'About the service'),
        'x-order': 2,
      },
      languages: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['nb', 'nn', 'en'],
          'x-enumLabels': {
            nb: t('Bokmål', 'Norwegian Bokmål'),
            nn: t('Nynorsk', 'Norwegian Nynorsk'),
            en: t('Engelsk', 'English'),
          },
        },
        default: ['nb', 'en'],
        'x-label': t('Svarspråk', 'Answer languages'),
        'x-group': t('Om tjenesten', 'About the service'),
        'x-order': 3,
      },
      model: {
        type: 'object',
        required: ['primary'],
        'x-label': t('Språkmodell', 'Language model'),
        'x-order': 10,
        properties: {
          primary: {
            type: 'string',
            'x-label': t('Hovedmodell', 'Primary model'),
            'x-widget': 'model',
            'x-options': { route: '/tenants/{tenant}/models', value: 'id', label: 'name' },
          },
          fallback: {
            type: 'string',
            'x-label': t('Reservemodell', 'Fallback model'),
            'x-widget': 'model',
            'x-options': { route: '/tenants/{tenant}/models', value: 'id', label: 'name' },
            'x-advanced': true,
          },
        },
      },
      instructions: {
        type: 'string',
        'x-label': t('Instruksjoner', 'Instructions'),
        'x-help': t('Det modellen alltid skal følge.', 'What the model must always follow.'),
        'x-widget': 'prompt',
        'x-order': 20,
      },
      strategy: {
        type: 'object',
        'x-label': t('Strategi', 'Strategy'),
        'x-order': 30,
        properties: {
          id: {
            type: 'string',
            enum: ['single-call', 'agent-loop'],
            'x-label': t('Strategi', 'Strategy'),
            'x-enumLabels': {
              'single-call': t('Ett kall', 'Single call'),
              'agent-loop': t('Agent', 'Agent'),
            },
          },
          config: { 'x-label': t('Oppsett for strategien', 'Strategy settings') },
        },
      },
    },
  },
  'Strategy.single-call@1': {
    type: 'object',
    properties: {
      maxTokens: {
        type: 'integer',
        exclusiveMinimum: 0,
        'x-label': t('Maks tokens i svaret', 'Max tokens in the answer'),
        'x-widget': 'number',
      },
    },
  },
  'StepFlow@v1': {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, 'x-label': t('Navn', 'Name'), 'x-order': 1 },
      steps: {
        type: 'array',
        'x-label': t('Steg', 'Steps'),
        'x-order': 2,
        items: {
          type: 'object',
          required: ['id', 'block'],
          properties: {
            id: { type: 'string', 'x-label': t('Id', 'Id') },
            block: { type: 'string', 'x-label': t('Byggekloss', 'Block') },
            params: {
              type: 'object',
              additionalProperties: true,
              'x-label': t('Innstillinger for steget', 'Step settings'),
            },
          },
        },
      },
    },
  },
  'Skill@v1': {
    type: 'object',
    required: ['name', 'instructions'],
    properties: {
      name: { type: 'string', minLength: 1, 'x-label': t('Navn', 'Name'), 'x-order': 1 },
      instructions: {
        type: 'string',
        'x-label': t('Instruksjoner', 'Instructions'),
        'x-widget': 'prompt',
        'x-order': 2,
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        'x-label': t('Verktøy', 'Tools'),
        'x-widget': 'multiselect',
        'x-options': { route: '/tenants/{tenant}/tools', value: 'id', label: 'name' },
        'x-order': 3,
      },
    },
  },
  'Model@v1': {
    type: 'object',
    required: ['deployment', 'residency'],
    properties: {
      deployment: {
        type: 'string',
        'x-label': t('Utrulling', 'Deployment'),
        'x-readOnly': true,
        'x-order': 1,
      },
      family: { type: 'string', 'x-label': t('Modellfamilie', 'Model family'), 'x-order': 2 },
      residency: {
        type: 'string',
        enum: ['norway', 'eu', 'global'],
        'x-enumLabels': {
          norway: t('Norge', 'Norway'),
          eu: t('EU/EØS', 'EU/EEA'),
          global: t('Globalt', 'Global'),
        },
        'x-label': t('Datalagring', 'Data residency'),
        'x-order': 3,
        'x-operator': true,
      },
      capabilities: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['stream', 'tools', 'json-schema', 'reasoning'],
          'x-enumLabels': {
            stream: t('Strømming', 'Streaming'),
            tools: t('Verktøy', 'Tools'),
            'json-schema': t('JSON-skjema', 'JSON schema'),
            reasoning: t('Resonnering', 'Reasoning'),
          },
        },
        'x-label': t('Egenskaper', 'Capabilities'),
        'x-order': 4,
      },
      enabled: {
        type: 'boolean',
        default: true,
        'x-label': t('Tilgjengelig for virksomheter', 'Available to agencies'),
        'x-order': 5,
      },
      apiKey: {
        type: 'string',
        'x-label': t('API-nøkkel', 'API key'),
        'x-sensitive': true,
        'x-order': 6,
        'x-operator': true,
      },
      parameters: {
        type: 'object',
        additionalProperties: false,
        'x-label': t('Parametere', 'Parameters'),
        'x-order': 7,
        properties: {
          temperature: rule(t('Temperatur', 'Temperature'), 1, {
            type: 'number',
            minimum: 0,
            maximum: 2,
            'x-widget': 'number',
          }),
          reasoning: rule(t('Resonnering', 'Reasoning'), 2, {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            'x-enumLabels': {
              low: t('Lav', 'Low'),
              medium: t('Middels', 'Medium'),
              high: t('Høy', 'High'),
            },
          }),
          maxTokens: rule(t('Maks tokens', 'Max tokens'), 3, {
            type: 'integer',
            exclusiveMinimum: 0,
            'x-widget': 'number',
          }),
        },
      },
    },
  },
  'Plugin.example-block@1': {
    type: 'object',
    properties: {
      timeoutSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: 120,
        default: 30,
        'x-label': t('Tidsgrense', 'Timeout'),
        'x-unit': t('sekunder', 'seconds'),
        'x-right': 'blocks.configure',
      },
      mode: {
        type: 'string',
        enum: ['fast', 'thorough'],
        default: 'fast',
        'x-enumLabels': { fast: t('Rask', 'Fast'), thorough: t('Grundig', 'Thorough') },
        'x-label': t('Modus', 'Mode'),
        'x-right': 'blocks.configure',
      },
    },
  },
  'PluginManifest@v1': {
    type: 'object',
    required: ['id', 'endpoint'],
    properties: {
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$', 'x-label': t('Id', 'Id'), 'x-order': 1 },
      endpoint: {
        type: 'string',
        format: 'uri',
        'x-label': t('Adresse', 'Endpoint'),
        'x-order': 2,
      },
      permissions: {
        type: 'array',
        items: { type: 'string', enum: ['read-datasets', 'call-models', 'network'] },
        'x-label': t('Tillatelser', 'Permissions'),
        'x-order': 3,
      },
      config: {
        type: 'object',
        additionalProperties: true,
        'x-label': t('Oppsett', 'Configuration'),
        'x-widget': 'code',
        'x-advanced': true,
        'x-order': 4,
      },
    },
  },
  'ToolConnection@v1': {
    type: 'object',
    required: ['name', 'kind', 'url'],
    properties: {
      name: { type: 'string', minLength: 1, 'x-label': t('Navn', 'Name'), 'x-order': 1 },
      kind: {
        type: 'string',
        enum: ['mcp', 'openapi', 'a2a'],
        'x-enumLabels': {
          mcp: t('MCP', 'MCP'),
          openapi: t('OpenAPI', 'OpenAPI'),
          a2a: t('A2A', 'A2A'),
        },
        'x-label': t('Type', 'Kind'),
        'x-order': 2,
      },
      url: {
        type: 'string',
        format: 'uri',
        'x-label': t('Adresse', 'URL'),
        'x-order': 3,
      },
      token: {
        type: 'string',
        'x-label': t('Tilgangsnøkkel', 'Access token'),
        'x-widget': 'secret',
        'x-sensitive': true,
        'x-order': 4,
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        'x-label': t('Ekstra hoder', 'Extra headers'),
        'x-widget': 'map',
        'x-advanced': true,
        'x-order': 5,
      },
    },
  },
  'Trigger@v1': {
    type: 'object',
    required: ['service', 'schedule'],
    properties: {
      service: {
        type: 'string',
        'x-label': t('Tjeneste', 'Service'),
        'x-widget': 'select',
        'x-options': { route: '/tenants/{tenant}/services', value: 'id', label: 'name' },
        'x-order': 1,
      },
      schedule: {
        type: 'string',
        'x-label': t('Når', 'When'),
        'x-widget': 'cron',
        'x-order': 2,
      },
      dataset: {
        type: 'string',
        'x-label': t('Datasett', 'Dataset'),
        'x-widget': 'dataset',
        'x-options': { route: '/tenants/{tenant}/datasets', value: 'id', label: 'name' },
        'x-order': 3,
      },
      enabled: { type: 'boolean', default: true, 'x-label': t('På', 'On'), 'x-order': 4 },
    },
  },
  'Block.model@1': {
    type: 'object',
    properties: {
      system: {
        type: 'string',
        'x-label': t('Systemledetekst', 'System prompt'),
        'x-widget': 'prompt',
        'x-order': 1,
      },
      temperature: {
        type: 'number',
        minimum: 0,
        maximum: 2,
        'x-label': t('Temperatur', 'Temperature'),
        'x-order': 2,
        'x-advanced': true,
      },
      maxTokens: {
        type: 'integer',
        exclusiveMinimum: 0,
        'x-label': t('Maks tokens i svaret', 'Max tokens in the answer'),
        'x-order': 3,
        'x-advanced': true,
      },
      stream: {
        type: 'boolean',
        default: false,
        'x-label': t('Strøm svaret', 'Stream the answer'),
        'x-order': 4,
      },
    },
  },
  'Settings@v1': {
    type: 'object',
    properties: {
      'answer.maxSources': {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        default: 5,
        'x-label': t('Maks antall kilder', 'Max sources'),
        'x-group': t('Svar', 'Answers'),
        'x-settableAt': ['platform', 'tenant', 'service'],
      },
      'retention.days': {
        type: 'integer',
        minimum: 1,
        maximum: 365,
        default: 90,
        'x-label': t('Lagringstid for logger', 'Log retention'),
        'x-unit': t('dager', 'days'),
        'x-group': t('Personvern', 'Privacy'),
        'x-settableAt': ['platform', 'tenant'],
      },
      'tracing.enabled': {
        type: 'boolean',
        default: false,
        'x-label': t('Sporing', 'Tracing'),
        'x-group': t('Drift', 'Operations'),
        'x-settableAt': ['platform'],
        'x-operator': true,
      },
    },
  },
};

const titles: Record<string, { nb: string; en: string }> = {
  Service: t('Tjeneste', 'Service'),
  StepFlow: t('Stegflyt', 'Step flow'),
  Skill: t('Ferdighet', 'Skill'),
  Model: t('Modell', 'Model'),
  'Plugin.example-block': t('Eksempelkloss', 'Example block'),
  PluginManifest: t('Plug-in', 'Plug-in'),
  ToolConnection: t('Verktøykobling', 'Tool connection'),
  Trigger: t('Utløser', 'Trigger'),
  'Block.model': t('Spør språkmodellen', 'Ask the language model'),
  Settings: t('Innstillinger', 'Settings'),
  'Strategy.single-call': t('Ett kall', 'Single call'),
};

const nested = new Set(['Block.model', 'Strategy.single-call', 'Plugin.example-block']);

const split = (key: string) => {
  const at = key.lastIndexOf('@');
  return { kind: key.slice(0, at), version: key.slice(at + 1) };
};

const href = (key: string) => `/schemas/${encodeURIComponent(key)}`;

const uses: Record<string, SchemaUse[]> = {
  Service: [
    {
      kind: 'Strategy.single-call',
      version: '1',
      at: 'strategy.config',
      when: { field: 'strategy.id', equals: 'single-call' },
      href: href('Strategy.single-call@1'),
    },
  ],
  StepFlow: [
    {
      kind: 'Block.model',
      version: '1',
      at: 'steps.params',
      when: { field: 'block', equals: 'model@1' },
      href: href('Block.model@1'),
    },
  ],
};

const refOf = (key: string): SchemaRef => {
  const { kind, version } = split(key);
  const title = titles[kind];
  return {
    kind,
    version,
    href: href(key),
    ...(title ? { label: title } : {}),
    ...(uses[kind] ? { uses: uses[kind] } : {}),
  };
};

export const fixtureSchemaList: SchemaRef[] = Object.keys(fixtureSchemas)
  .filter((key) => !nested.has(split(key).kind))
  .map(refOf);

const listed = (ref: SchemaRef) => ({
  kind: ref.kind,
  version: ref.version,
  apiVersion: 'genai/v1',
  title: ref.label,
  href: ref.href,
  uses: ref.uses ?? [],
});

export const fixtureSchemaFetch = (extra: Record<string, UiSchema> = {}) => {
  const all = { ...fixtureSchemas, ...extra };
  const list = [...fixtureSchemaList, ...Object.keys(extra).map(refOf)].map(listed);
  return (path: string): unknown => {
    if (path === '/schemas') return { data: list };
    const m = /^\/schemas\/(.+)$/.exec(path);
    if (!m) return undefined;
    return all[decodeURIComponent(m[1] ?? '')];
  };
};
