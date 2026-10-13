export interface OperatorSession {
  name: string;
  roles: string[];
  token: string;
  idToken?: string;
}

export type TenantStatus = 'active' | 'onboarding' | 'paused';

export interface Tenant {
  orgNumber: string;
  name: string;
  status: TenantStatus;
  services: number;
  quotaUsedPercent?: number;
  admin?: string;
  stage?: string;
  note?: string;
  servicesActive?: number;
  tokensMillions?: number;
  quotaMillions?: number;
  costNok?: number | null;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  error?: string;
  errors?: { path?: string; message: string }[];
  services?: unknown[];
  datasets?: unknown[];
}

export type Residency = 'norway' | 'eu' | 'global';

export type Capability = 'stream' | 'tools' | 'json-schema' | 'reasoning';

export interface ModelUsage {
  tenant: string;
  service: string;
  role: string;
}

export interface OperatorModel {
  id: string;
  endpoint: string;
  deployment: string;
  family?: string;
  residency: Residency;
  capabilities: Capability[];
  enabled: boolean;
  origin: 'catalog' | 'discovered';
  classified: boolean;
  usage?: ModelUsage[];
  price?: ModelPrice | null;
  parameters?: ParameterRules;
  rejectedParameters?: Partial<Record<TunableParameter, string>>;
}

export type TunableParameter = 'temperature' | 'reasoning' | 'maxTokens';
export type ParameterRule = { mode: 'unsupported' } | { mode: 'fixed'; value: number | string };
export type ParameterRules = Partial<Record<TunableParameter, ParameterRule>>;

export interface ModelPrice {
  inputPerThousand: number;
  outputPerThousand: number;
}

export interface ModelClassification {
  residency?: Residency;
  capabilities?: Capability[];
  enabled?: boolean;
  parameters?: ParameterRules;
}

export interface RefreshResult {
  discovered: number;
  failed: { endpoint: string; error: string }[];
}

export interface SupportSession {
  id: string;
  operator: string;
  operatorName?: string;
  tenant: string;
  reason: string;
  openedAt: string;
  expiresAt: string;
}

export interface AuditEntry {
  task: string;
  tenant: string;
  action: string;
  actor: string;
  onBehalfOf?: string;
  at: string;
  outcome: 'applied' | 'rejected';
  target: string;
  reason: string;
  actorName?: string;
  actorOrg?: string;
  tenantName?: string;
  actionLabel?: string;
}

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

export interface SettingOverrides {
  tenants: Record<string, { values: Record<string, unknown>; pins: Record<string, number> }>;
  services: {
    tenant: string;
    service: string;
    version: number;
    settings: Record<string, unknown>;
  }[];
}

export interface DefaultVersion {
  key: string;
  version: number;
  value: unknown;
  changedAt?: string;
  changedBy?: string;
  reason?: string;
}

export interface ServiceImpact {
  tenant: string;
  service: string;
  version: number;
  status: 'changes' | 'pinned' | 'overridden' | 'unchanged';
  before: unknown;
  after: unknown;
}

export interface Health {
  status: 'ok';
  version: string;
}

export interface ImportPlanItem {
  target: string;
  action: string;
  conflict: boolean;
}

export interface ImportResult {
  dryRun: boolean;
  task?: string;
  plan: ImportPlanItem[];
}

export interface ValidationProblem extends Problem {
  errors?: { path: string; message: string }[];
}

export interface SharedService {
  tenant: string;
  id: string;
  name: string;
  version: number;
  availableTo: string[] | '*' | null;
  publicNames: string[];
}

export interface BuildingBlock {
  ref: string;
  description?: string;
  configSchema?: unknown;
  usedBy: string[];
}

export type Availability = 'all' | 'selected' | 'none';

export interface ContractTest {
  name: string;
  passed: boolean;
  skipped?: boolean;
  reason?: string;
}

export interface PluginCheck {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
  ms: number;
}

export interface ContractRun {
  passed: boolean;
  version: string;
  endedAt: string;
  results: PluginCheck[];
}

export interface PluginSummary {
  kind: string;
  id: string;
  version: string;
  contract: string;
  title: string;
  description: string;
  publisher: string;
  origin: 'builtin' | 'external';
  capabilities: string[];
  dataLocation: string | null;
  configSchema?: unknown;
  secrets: string[];
  hosts: string[];
  verifiable: boolean;
  contractTests: {
    passed: boolean;
    version: string;
    at: string;
    trigger: string;
    results: PluginCheck[];
  } | null;
  history: { version: string; passed: boolean; at: string }[];
}

export interface RegistryBlock {
  id: string;
  type: string;
  name: string;
  version: string;
  testPassed?: boolean;
  testedAt?: string;
  tests?: ContractTest[];
  availability?: Availability;
  agencies?: string[];
  serviceCount: number;
  services: { tenant: string; service: string; detail?: string }[];
  settingsSchema?: {
    field: string;
    type: string;
    default: string;
    allowed: string;
    description: string;
  }[];
  changelog?: { version: string; at: string; text: string }[];
  next?: {
    version: string;
    description: string;
    breakingChanges: string[];
    testPassed: boolean;
    testedAt: string;
  };
  badge?: string;
  provider?: string;
  configSchema?: unknown;
  verifiable?: boolean;
  manifest?: string;
  origin?: 'builtin' | 'external';
  dataLocation?: string | null;
}

export interface BlockType {
  id: string;
  name: string;
  description: string;
}

export interface BuildingBlocks {
  strategies: BuildingBlock[];
  blocks: BuildingBlock[];
  tools: BuildingBlock[];
  types?: BlockType[];
  registry?: RegistryBlock[];
  agencies?: string[];
  plugins?: PluginSummary[];
}

export interface MetricSummary {
  mean: number;
  ci: [number, number];
  n: number;
}

export interface QualityRow {
  tenant: string;
  service: string;
  testSet: string;
  run: string;
  subject?: string;
  endedAt: string;
  servedModels: string[];
  metrics: Record<string, MetricSummary>;
  regressions: string[];
}

export interface JudgeCalibration {
  judge: string;
  kappa: number;
  observed: number;
  n: number;
  blocking: boolean;
  advisory: boolean;
  name?: string;
  model?: string;
  measuredAt?: string;
  jobTypes?: string[];
  kappaByLanguage?: Record<string, (number | null)[]>;
}

export type MatrixColumnStatus = 'in_use' | 'new' | 'allowed' | 'review';

export interface QualityMatrix {
  columns: { name: string; status: MatrixColumnStatus }[];
  baseline: number[];
  rows: { testSet: string; kind: string; scores: (number | null)[]; advisoryJudge?: string }[];
}

export interface MatrixRun {
  id: string;
  model: string;
  current: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  startedAt: string;
  endedAt: string | null;
  estimatedCostNok: number;
  costNok: number | null;
  testSets: number;
  done: number;
  error?: string;
}

export interface MatrixScore {
  score: number | null;
  passed: number;
  total: number;
}

export interface MatrixRunDetail extends MatrixRun {
  rows: {
    tenant: string;
    service: string;
    name: string;
    testSet: string;
    cases: number;
    current: MatrixScore | null;
    candidate: MatrixScore | null;
  }[];
}

export interface MatrixEstimate {
  model: string;
  current: string;
  testSets: { tenant: string; service: string; name: string; testSet: string; cases: number }[];
  cases: number;
  estimatedCostNok: number;
  unpriced: string[];
}

export interface QualityHistory {
  weeks: string[];
  series: { name: string; kind: string; scores: number[] }[];
  events: { week: number; text: string }[];
}

export interface QualityOverview {
  services: QualityRow[];
  judges: JudgeCalibration[];
  matrix?: { models: QualityMatrix; blocks: QualityMatrix };
  matrixRuns?: MatrixRun[];
  candidates?: { id: string; residency: string | null; testSets?: number }[];
  modelsInUse?: { id: string; services: number }[];
  history?: QualityHistory;
}

export type Verdict = 'Ja' | 'Delvis' | 'Nei';

export interface LabelItem {
  item: string;
  judge: string;
  judgeLabel: 'good' | 'bad';
  tenant: string;
  service: string;
  case: string;
  reason?: string;
  question?: string;
  answer?: string;
  sources?: string[];
  lang?: 'nb' | 'nn';
  meta?: string;
  judgeCriteria?: { correct: Verdict; grounded: Exclude<Verdict, 'Delvis'> };
}

export interface TraceField {
  key: string;
  label: string;
  type: 'url' | 'text' | 'secret';
  placeholder: string;
  help: string;
}

export interface TraceTool {
  id: string;
  name: string;
  description: string;
  fields: TraceField[];
}

export type Hosting = 'norway' | 'eu' | 'outside';

export interface TraceConnection {
  status: 'ok' | 'failing';
  hosting: Hosting;
  values: Record<string, string>;
  secretsStored: boolean;
  scope: string[];
  content: 'meta' | 'full';
  mask: boolean;
  sampleRate: number;
  syncScores: boolean;
  annotations: boolean;
  lastDelivery?: string;
  sent24h?: number;
  queued?: number;
  error?: { what: string; why: string; code: string };
}

export interface TracingStatus {
  enabled: boolean;
  source: 'environment' | 'registry';
  endpoint?: string;
  content?: boolean;
  sampleRate?: number;
  stats?: { exported: number; dropped: number; failed: number; sampledOut: number };
  tools?: TraceTool[];
  connections?: Record<string, TraceConnection>;
  tenantConnections?: {
    tenant: string;
    tool: string;
    content: string;
    status: 'ok' | 'failing';
    lastDelivery: string;
  }[];
}

export type TraceSettings = Omit<
  TraceConnection,
  'status' | 'lastDelivery' | 'sent24h' | 'queued' | 'error' | 'secretsStored'
> & { secrets: Record<string, string> };

export interface SupportSessionRow extends SupportSession {
  endedAt?: string;
  status: 'active' | 'expired' | 'ended';
}

export interface RunningTask {
  task: string;
  tenant: string;
  status: string;
  at: string;
  service?: string;
  capability?: string;
}

export interface OnboardingStep {
  doneBy?: string;
  doneAt?: string;
  note?: string;
}

export interface OnboardingRequest {
  id?: string;
  orgNumber: string;
  name: string;
  requestedAt: string;
  requestedBy: string;
  steps: {
    request: OnboardingStep;
    terms: OnboardingStep;
    access: OnboardingStep;
    login: OnboardingStep;
  };
  checklist?: { done: number; total: number };
}

export interface OperationsOverview {
  incidents: { title: string; text: string }[];
  components: {
    name: string;
    status: 'normal' | 'degraded' | 'down';
    errorRate?: string;
    p95?: string;
    note?: string;
  }[];
  queueStats: { label: string; value: string }[];
  queue: {
    type: string;
    what: string;
    status: 'running' | 'waiting' | 'failed';
    progress?: string;
    age: string;
  }[];
  triggers: {
    tenant: string;
    what: string;
    error: string;
    lastSuccess?: string;
    failedAt?: string;
    waiting?: string;
  }[];
}

export interface Block {
  kind: 'quote' | 'kv' | 'list' | 'tags' | 'answer';
  label?: string;
  text?: string;
  rows?: [string, string][];
  items?: string[];
}

export interface TaskTimeline {
  id: string;
  service: string;
  status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  trigger: string;
  caller: string;
  startedAt: string;
  durationSeconds: number;
  inputTokens: number;
  outputTokens: number;
  costOre: number;
  steps: {
    id: string;
    type: string;
    title: string;
    summary: string;
    at: number;
    durationSeconds?: number;
    blocks: Block[];
  }[];
  serviceName?: string;
  version?: number;
  callerPseudonym?: string;
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
  label?: string;
  note?: string;
}

export type EffectiveSettings = Record<string, EffectiveSetting>;

export type RiskLevel = 'minimal' | 'limited' | 'high';

export type SettingType =
  'int' | 'float' | 'enum' | 'bool' | 'list' | 'secret' | 'risk' | 'text' | 'json';

export type Sensitivity = 'low' | 'medium' | 'high' | 'secret';

export type SettingScope = 'tenant' | 'service' | 'dataset';

export interface GridSetting {
  key: string;
  category: string;
  label: string;
  description: string;
  type: SettingType;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  multiline?: boolean;
  options?: { value: string; label: string }[];
  sensitivity: Sensitivity;
  scope: SettingScope[];
  platform: unknown;
  version: number;
  tenants: Record<string, unknown>;
  services: Record<string, unknown>;
  pins?: Record<string, { version: number; value: unknown }>;
  needs?: Record<string, number>;
  rule?: string;
  floor?: Partial<Record<RiskLevel, unknown>>;
  floorText?: string;
}

export interface SettingsGrid {
  platformVersion: number;
  platformDate: string;
  tenants: string[];
  services: { tenant: string; name: string; risk?: RiskLevel }[];
  settings: GridSetting[];
}

export interface TenantDefinition {
  kind: 'Service' | 'StepFlow';
  id: string;
  name: string;
  latestVersion: number;
  publishedAt: string | null;
  publishedBy: string | null;
  publishedByName?: string;
  state?: 'active' | 'paused' | 'archived';
}

export interface VersionSummary {
  version: number;
  publishedBy: string;
  publishedByName?: string;
  publishedAt: string;
  reason: string;
}

export interface DefinitionVersion extends VersionSummary {
  definition: Record<string, unknown>;
  files: Record<string, string>;
}

export interface TenantDefinitionHistory {
  kind: 'Service' | 'StepFlow';
  tenant: string;
  id: string;
  latest: DefinitionVersion;
  versions: VersionSummary[];
}

export interface ConfigEntry {
  id: string;
  kind?: string;
  scope?: string;
  version: number;
  spec: Record<string, unknown>;
  mandatory?: boolean;
  builtin?: boolean;
  editable?: boolean;
  origin?: string;
  by?: string;
  at?: string;
  reason?: string;
}

export interface ConfigVersion {
  version: number;
  spec: unknown;
  deleted?: boolean;
  by: string;
  at: string;
  reason: string;
}

export interface IngestionBackend {
  name: string;
  available: boolean;
  reason?: string;
}

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: (string | number)[];
  enumTitles?: string[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  const?: unknown;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  'x-secret'?: boolean;
}

export type DataLocation = 'norway' | 'eu' | 'global';

export interface KnowledgeEngine {
  engine: string;
  title: string;
  tech?: string;
  builtin: boolean;
  runsAt?: string;
  dataLocation?: DataLocation;
  writeKeyRequired?: boolean;
  probe?: boolean;
  requiresBaseURL?: boolean;
  endpoint?: JsonSchema;
  endpointOptions?: JsonSchema;
  capabilities: string[];
}

export type EndpointStatus = 'ok' | 'unused' | 'skipped';

export type EngineCapability =
  | 'text_search'
  | 'vector_search'
  | 'hybrid'
  | 'filters'
  | 'facets'
  | 'full_document'
  | 'ordered_passages';

export interface KnowledgeEndpoint {
  id: string;
  name: string;
  scope: string;
  engine: string;
  title: string;
  tech?: string;
  builtin: boolean;
  runsAt: string;
  dataLocation?: DataLocation;
  embeddingModel?: string;
  writeKeyRequired: boolean;
  capabilities: { supported: EngineCapability[]; missing: EngineCapability[] };
  datasetCount: number;
  status: EndpointStatus;
  shared: boolean;
  version: number;
}

export interface KnowledgeEndpointItem {
  id: string;
  kind: 'knowledge-endpoint';
  scope: string;
  version: number;
  spec: Record<string, unknown>;
}

export interface StoredSecret {
  ref: string;
  name: string;
  updatedAt?: string;
}

export interface EndpointTestResult {
  ok: boolean;
  engine?: string;
  code?: string;
  message: string;
  ms: number;
}

export interface Decision {
  by?: string;
  byName?: string;
  at?: string;
  reason?: string;
}

export interface BlockApprovalRequest {
  id: string;
  tenant: string;
  tenantName?: string;
  block: {
    kind: string;
    id: string;
    version: string;
    name?: string;
    publisher?: string;
    dataLocation?: Residency | null;
    rule?: { rule: string; ownedBy: string; text: string };
    access?: { type: string; value: string; note: string }[];
    scores?: { testSet: string; service: string; score: number }[];
    services?: string[];
  };
  reason?: string;
  requestedBy?: string;
  requestedAt: string;
  status?: string;
  state?: string;
  grants?: string;
  decision?: Decision;
}

export interface SkillShareRequest {
  id: string;
  tenant: string;
  tenantName?: string;
  skill: string;
  skillName?: string;
  version: string | number;
  state: string;
  by?: string;
  byName?: string;
  at: string;
  reason?: string;
  decision?: Decision & { approved?: boolean };
  detail?: {
    description: string;
    instructions: string;
    tools: string[];
    test: { score: number | null; passed?: number; total?: number; threshold: number };
    previous?: { version: number; instructions: string };
  };
}

export interface PlatformProposal {
  id: string;
  tenant: string;
  tenantName?: string;
  title: string;
  summary?: string;
  status: string;
  createdAt: string;
  createdBy?: string;
  caseId?: string;
  ask?: string;
  detail?: string;
  forService?: { id: string; name: string };
  platformChange?: { status: 'sent' | 'under_review' | 'planned' | 'rejected'; caseId?: string };
  decision?: Decision;
}

export interface AccessRequest {
  id: string;
  org: string;
  orgName?: string;
  contactName?: string;
  contactEmail?: string;
  purpose?: string;
  requestedBy?: string;
  requesterName?: string;
  requestedAt: string;
  status: string;
  terms?: { at: string; version?: string };
  decision?: { by: string; byName?: string; at: string; reason: string };
}

export interface TenantKey {
  id: string;
  name: string;
  prefix?: string | null;
  lastFour?: string | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface QuarantinedDefinition {
  tenant: string;
  kind: string;
  id: string;
  version?: number | string;
  errors: (string | { path?: string; message: string })[];
  at: string;
}

export type ModelProtocol = 'openai-chat' | 'anthropic-messages';

export interface ModelEndpointInput {
  id: string;
  protocol: ModelProtocol;
  baseURL: string;
  auth: { kind: 'api-key' | 'bearer'; secret: string };
}

export interface ModelSettings {
  endpoint: string;
  deployment: string;
  family?: string;
  residency: Residency;
  capabilities: Capability[];
  enabled: boolean;
}
