export const apiTags = [
  {
    name: 'Frontend',
    description:
      'What your own frontend, chat client or agent calls: OpenAI-compatible /v1, conversations, feedback, datasets and facets, tools, MCP and A2A. Authenticate with an API key bound to a service, or an Ansattporten token.',
  },
  {
    name: 'Services and definitions',
    description:
      'Build and publish services: definitions and versions, drafts, test runs in the playground, proposals, skills, step-flow blocks, settings and pins, export and import, shared services. Needs Administrere tjenester for changes.',
  },
  {
    name: 'Datasets and knowledge',
    description:
      'Datasets and what fills them: pipelines, uploads, enrichment, search engines and engine switches, knowledge endpoints, the catalogue and the models a tenant may use. Needs Administrere datasett for changes.',
  },
  {
    name: 'Access and extensions',
    description:
      'Who and what may call the platform, and what the platform may call: rights, API keys and key policies, clients, Maskinporten clients, secrets, tool connections, connectors, building blocks, plugins, hooks, onboarding. /mock routes exist only in local development.',
  },
  {
    name: 'Work and quality',
    description:
      'Running work and measuring it: projects, tasks and reviews, batch runs, triggers, test sets and eval runs, improvements, test case candidates, gates, guardrail rules, diagnostics, feedback, usage, audit and the tenant overview.',
  },
  {
    name: 'Operations',
    description:
      'Operator-only routes for the console: tenants and organisations, support sessions, platform datasets, models and catalogue, shared services, quality matrix, plugins and building blocks, usage, audit, tracing and running tasks.',
  },
  {
    name: 'Platform',
    description:
      'The platform describing itself: health, this OpenAPI document, the browsable reference and the published configuration schemas. Open to everyone.',
  },
] as const;

export type ApiTag = (typeof apiTags)[number]['name'];

const rules: [RegExp, ApiTag][] = [
  [/^\/(health|up|openapi\.json|reference)(\/|$)|^\/schemas(\/|$)/, 'Platform'],
  [/^\/(v1|api|a2a)(\/|$)/, 'Frontend'],
  [/^\/(operator|support-sessions)(\/|$)/, 'Operations'],
  [/^\/mock\/|^\/onboarding\//, 'Access and extensions'],
  [/^\/(eval-tasks|eval-runs|testcase-candidates|tasks)\//, 'Work and quality'],
  [/^\/models$/, 'Datasets and knowledge'],
  [/^\/tenants\/\{tenant\}\/services\/\{service\}\/api-keys$/, 'Access and extensions'],
  [
    /^\/tenants\/\{tenant\}\/services\/\{id\}\/(test-sets|eval-runs|improvements|batch-runs)(\/|$)/,
    'Work and quality',
  ],
  [/^\/tenants\/\{tenant\}\/(datasets|knowledge|catalog)(\/|$)/, 'Datasets and knowledge'],
  [
    /^\/tenants\/\{tenant\}\/(access|api-keys|api-key-policies|clients|maskinporten-clients|me|integrations|tool-connections|secrets|connectors|private-networks|building-blocks|plugins|hooks)(\/|$)/,
    'Access and extensions',
  ],
  [
    /^\/tenants\/\{tenant\}\/(projects|tasks|test-sets|eval-runs|feedback|testcase-candidates|gates|guardrail-rules|diagnostics|usage|audit|overview|triggers)(\/|$)/,
    'Work and quality',
  ],
  [
    /^\/tenants\/\{tenant\}\/(definitions|services|skills|skill-tools|step-flows|playground|proposals|settings|pins|export|import)(\/|$)/,
    'Services and definitions',
  ],
  [/^\/(definitions|services|settings|shared-services)(\/|$)/, 'Services and definitions'],
];

export const tagOf = (path: string): ApiTag | undefined =>
  rules.find(([pattern]) => pattern.test(path))?.[1];
