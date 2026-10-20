export type DefinitionKind = 'Service' | 'StepFlow' | 'Skill';

export interface DefinitionListItem {
  kind: DefinitionKind;
  id: string;
  latestVersion: number;
}

export interface VersionSummary {
  version: number;
  publishedBy: string;
  publishedByName?: string;
  publishedAt: string;
  reason: string;
}

export interface PublishedDefinition extends VersionSummary {
  kind: DefinitionKind;
  tenant: string;
  id: string;
  definition: Record<string, unknown>;
  files?: Record<string, string>;
}

export interface DefinitionWithHistory {
  kind: DefinitionKind;
  tenant: string;
  id: string;
  latest: PublishedDefinition;
  versions: VersionSummary[];
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  error?: string;
  errors?: { path: string; message: string }[];
}

export interface Organisation {
  orgNumber: string;
  name: string;
  actions?: string[];
}

export type PortalRight =
  | 'use-services'
  | 'manage-services'
  | 'manage-datasets'
  | 'register-building-blocks'
  | 'view-usage';

export interface Session {
  name: string;
  organisations: Organisation[];
  token: string;
}

export type TaskStatus = 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

export interface TimelineBlock {
  kind:
    'quote' | 'kv' | 'list' | 'tags' | 'answer' | 'fields' | 'doc' | 'error' | 'note' | 'reasoning';
  label?: string;
  text?: string;
  rows?: [string, string][];
  items?: string[] | [string, string][];
  title?: string;
  body?: string;
  sources?: string[];
}

export type TimelineStepState =
  | 'ok'
  | 'running'
  | 'waiting'
  | 'pending'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'skipped'
  | 'partial'
  | 'retried';

export interface TimelineStep {
  id: string;
  type: string;
  title: string;
  summary: string;
  at: number;
  durationSeconds?: number;
  blocks: TimelineBlock[];
  state?: TimelineStepState;
  tokens?: number;
  description?: string;
  depth?: number;
  model?: string;
  iteration?: number;
  warning?: true;
  raw?: unknown;
}

export interface TaskTimeline {
  id: string;
  service: string;
  serviceName?: string;
  status: TaskStatus;
  trigger: string;
  caller: string;
  startedAt: string;
  durationSeconds: number;
  inputTokens: number;
  outputTokens: number;
  costOre: number | null;
  steps: TimelineStep[];
}

export type Residency = 'norway' | 'eu' | 'global';

export interface ModelPrice {
  inputPerThousand: number;
  outputPerThousand: number;
}

export interface ModelOption {
  id: string;
  name?: string;
  family?: string;
  residency: Residency;
  capabilities: string[];
  price?: ModelPrice | null;
  parameters?: {
    temperature?: { mode: 'unsupported' } | { mode: 'fixed'; value: number | string };
  };
}

export interface DatasetSummary {
  id: string;
  name: string;
  description: string;
  'enabled?': boolean;
  status: string;
}

export interface FacetOption {
  value: string;
  count: number;
  selected: boolean;
}

export interface FacetField {
  field: string;
  options: FacetOption[];
}

export type SettingLayer = 'platform' | 'tenant' | 'service' | 'call' | 'dataset';

export interface SettingInfo {
  key: string;
  description: string;
  category: string;
  axis: 'service' | 'dataset';
  sensitivity: 'normal' | 'secret';
  default: unknown;
  settableAt: string[];
  schema?: Record<string, unknown>;
}

export interface SettingDefaultVersion {
  key: string;
  version: number;
  value: unknown;
  changedAt?: string;
  changedBy?: string;
  reason?: string;
}

export interface EffectiveSetting {
  key: string;
  value: unknown;
  source: string;
  pinnedVersion?: number;
  defaultVersion: number;
  overridden: { layer: string; value: unknown }[];
  rejected: { layer: string; reason: string }[];
  locked?: string;
}

export interface ServiceImpact {
  tenant: string;
  service: string;
  version: number;
  status: 'changes' | 'pinned' | 'overridden' | 'unchanged';
  before: unknown;
  after: unknown;
}

export interface SettingPreview {
  dryRun: true;
  services: ServiceImpact[];
}

export type Split = 'train' | 'validation' | 'holdout';

export interface TestCaseSummary {
  id: string;
  split: Split;
  input: string | { data?: unknown; parts?: unknown[] };
  tags: string[];
  needsReview: boolean;
  expected: { referenceAnswer?: string; sources?: unknown[] };
}

export interface TestSet {
  metadata: { tenant: string; id: string; name: string; version: number };
  spec: { service?: string; corpus?: string; cases: TestCaseSummary[] };
}

export interface MetricSummary {
  mean: number;
  ci: [number, number];
  n: number;
}

export interface EvalRunSummary {
  id: string;
  testSet: { tenant: string; id: string; version: number };
  capability: string;
  startedAt: string;
  endedAt: string;
  provenance: { commit: string; servedModels: string[]; judges: string[] };
  metrics: Record<string, MetricSummary>;
}

export interface FeedbackItem {
  task?: string;
  rating: 'up' | 'down';
  comment?: string;
  at: string;
}

export interface CapabilityModel {
  id: string;
  description?: string;
  _agent_id?: string;
  _mode?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: { path: string; message: string }[];
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  runs?: number;
  costMicroNok: number | null;
  priced?: boolean;
}

export interface TaskActor {
  kind: 'person' | 'api-key' | 'system';
  name?: string;
}

export interface TaskRow {
  id: string;
  status: string;
  service: string;
  serviceName?: string;
  excerpt?: string;
  actor?: TaskActor;
  capability: string;
  createdAt: string;
  endedAt: string | null;
  usage: UsageTotals;
}

export interface ServiceLifecycleView {
  state: 'active' | 'paused' | 'archived';
  reason?: string;
  by?: string;
  at?: string;
}

export interface ServiceSummaryView {
  id: string;
  name: string;
  purpose: string;
  outputKind: string;
  channels: string[];
  latestVersion: number | null;
  status: 'active' | 'paused';
  statusReason: string | null;
  lifecycle: 'active' | 'paused' | 'archived';
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByName?: string;
  runsThisWeek: number;
}

export interface Overview {
  services: {
    id: string;
    name: string;
    latestVersion: number | null;
    status?: 'active' | 'paused';
    runsThisWeek?: number;
  }[];
  recentTasks: TaskRow[];
  usageThisMonth: UsageTotals;
  qualityWarnings: { service: string; message: string }[];
  review: { pendingToolChanges: number; failedTasksLastDay: number };
}

export interface SharedService {
  tenant: string;
  id: string;
  name: string;
  purpose: string;
  version: number | null;
  riskClass: string | null;
  residency: string | null;
  model?: string | null;
  exposure: string[];
  variants: { id: string; publicName: string; aliases: string[] }[];
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string | null;
  lastFour: string | null;
  scopes: string[];
  datasets: string[];
  agents: string[];
  callsPerMinute?: number | null;
  service?: string | null;
  policy?: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export type ClientChannel = 'mcp' | 'openai' | 'rest' | 'conversations' | 'feedback' | 'facets';
export type WebhookEvent = 'task.completed' | 'feedback.received';

export interface ClientSpec {
  service: string;
  kind: 'server' | 'browser';
  url?: string;
  channels: ClientChannel[];
  allowedOrigins: string[];
  oidc?: {
    clientId: string;
    audience?: string;
    redirectUris: string[];
    postLogoutRedirectUris?: string[];
  };
  webhook?: { url: string; events: WebhookEvent[]; secret: string };
}

export interface WebhookDelivery {
  id: string;
  event: string;
  at: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface ClientView {
  definition: {
    apiVersion: string;
    kind: 'Client';
    metadata: { tenant: string; id: string; name?: string };
    spec: ClientSpec;
  };
  version: number;
  updatedAt: string;
  updatedBy: string;
  deliveries: WebhookDelivery[];
}

export interface ClientsView {
  clients: ClientView[];
  endpoints: Partial<Record<ClientChannel, string[]>>;
  oidc: { issuer?: string; audience?: string; altinnResource?: string };
}

export interface ServiceKeyView extends ApiKeyView {
  service: string | null;
  client: string | null;
  lastUsedAt: string | null;
  rotatedFrom: string | null;
  allowedOverrides: string[];
}

export interface AccessView {
  services: {
    id: string;
    name: string;
    publicName: string;
    requirement: { resource: string; action: string; scope?: string };
  }[];
  keys: ApiKeyView[];
}

export interface UsageReport {
  from: string;
  to: string;
  priced: boolean;
  totals: UsageTotals;
  daily: {
    date: string;
    usage: UsageTotals;
    byService?: Record<string, UsageTotals>;
    byModel?: Record<string, UsageTotals>;
  }[];
  byService: { service: string; title?: string; usage: UsageTotals }[];
  byModel: { model: string; usage: UsageTotals }[];
  byProject?: { project: string; name: string; usage: UsageTotals }[];
  project?: string;
}

export interface ConnectionView {
  id: string;
  name: string;
  endpoint: string;
  version: string;
  allow: { host: string; port?: number }[];
  auth: { kind: string; secret: string } | null;
  tools: { name: string; description: string }[];
  pending: { name: string; description: string }[];
}

export interface IntegrationsView {
  connections: ConnectionView[];
  traces: { enabled: boolean; content: boolean };
}
