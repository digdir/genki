import type { ApiContext } from '../api';
import { modelLabel } from '../models';
import type { Residency } from '../types';

export type BlockKind =
  | 'model'
  | 'dataset'
  | 'search_engine'
  | 'tool'
  | 'skill'
  | 'extension_point'
  | 'guardrail'
  | 'judge'
  | 'step_flow'
  | 'shared_service';

export type BlockStatus =
  'in_use' | 'available' | 'requires_approval' | 'pending_approval' | 'not_allowed';

export type DataLocation = Residency;

export type ExtensionPoint =
  | 'before_search'
  | 'after_search'
  | 'before_model'
  | 'after_model'
  | 'before_tool'
  | 'on_publish'
  | 'on_feedback';

export interface Permission {
  type: 'network' | 'secret' | 'data' | 'model';
  value: string;
  note?: string;
}

export interface ContractTest {
  name: string;
  passed: boolean;
  reason?: string;
}

export interface SettingProperty {
  type: 'boolean' | 'integer' | 'number' | 'string';
  title: string;
  description?: string;
  default: boolean | number | string;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  enum?: string[];
  enumTitles?: string[];
  'x-unit'?: string;
}

export interface SettingsSchema {
  type: 'object';
  properties: Record<string, SettingProperty>;
  additionalProperties?: false;
}

export type SettingValue = boolean | number | string;

export interface BlockUser {
  id: string;
  name: string;
  version?: number;
}

export interface BlockScore {
  testSet: string;
  service: string;
  score: number;
  run: string;
  at: string;
}

export interface BlockUpdate {
  version: string;
  availableFrom: string;
  notes: string;
  perService: { service: string; scoreBefore: number | null; scoreAfter: number | null }[];
}

export interface LoggedChange {
  by: string;
  at: string;
  reason: string;
}

export interface PendingRequest extends LoggedChange {
  id: string;
}

export interface CatalogItem {
  id: string;
  kind: BlockKind;
  name: string;
  description: string;
  publisher: { type: 'digdir' | 'own' | 'shared'; name: string };
  version: string;
  latestVersion?: string;
  update?: BlockUpdate;
  dataLocation: DataLocation | null;
  status: BlockStatus;
  policyBlock?: { rule: string; ownedBy: string; text: string };
  approver?: string;
  capabilities: string[];
  permissions: Permission[];
  usedBy: BlockUser[];
  scores: BlockScore[];
  settingsSchema: SettingsSchema;
  tenantOverrides: Record<string, SettingValue>;
  settingsVersion: number;
  right: 'manage-services' | 'manage-datasets';
  changedBy?: LoggedChange;
  pendingRequest?: PendingRequest;
  extensionPoint?: ExtensionPoint;
  isNew?: boolean;
  /** A judge from the project of one of the tenant's Langfuse connections. */
  judge?: SinkJudgeInfo;
}

export interface SinkJudgeInfo {
  connection: string;
  model?: string | undefined;
  version: string;
  dataType: string;
  fields: { variable: string; source: string; jsonPath?: string }[];
  refused?: { reason: string; field?: string; connection?: string; message: string };
}

export interface BuildingBlockList {
  data: CatalogItem[];
  counts: { inUse: number; catalog: number; byKind: Record<BlockKind, number> };
}

export type BlockEvent =
  'adopted' | 'approval_requested' | 'approved' | 'rejected' | 'withdrawn' | 'settings';

export interface SettingChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface BlockVersion {
  source: 'publisher' | 'tenant';
  version: string;
  at?: string;
  by?: string;
  reason?: string;
  event?: BlockEvent;
  changes?: SettingChange[];
}

export interface BlockChangeResult {
  block: CatalogItem;
  version: number;
  changes: SettingChange[];
  affectedServices: BlockUser[];
}

export interface ApprovalRequest {
  id: string;
  tenant: string;
  kind: BlockKind;
  block: string;
  blockName: string;
  approver: string;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  reason: string;
  requestedBy: string;
  requestedAt: string;
  grants?: 'writes';
  decision?: LoggedChange;
}

export type RegistrationType = 'mcp' | 'openapi' | 'a2a' | 'extension_point' | 'skill_package';

export interface RegistrationAuth {
  kind: 'none' | 'bearer' | 'api-key' | 'maskinporten' | 'oauth-client-credentials';
  secret?: string;
  header?: string;
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
}

export interface RegistrationInput {
  type: RegistrationType;
  name: string;
  id?: string;
  endpoint?: string;
  auth?: RegistrationAuth;
  extensionPoint?: ExtensionPoint;
  document?: string;
  documentUrl?: string;
  operations?: string[];
  writes?: boolean;
}

export interface TenantSecretName {
  name: string;
  ref: string;
  allowedHosts?: string[];
}

export interface AgentCardSummary {
  name: string;
  description: string;
  version?: string;
  provider?: string;
  skills: { name: string; description?: string }[];
}

export interface ContractTestReport {
  type: RegistrationType;
  passed: boolean;
  results: ContractTest[];
  tools: RegisteredTool[];
  agent?: AgentCardSummary;
}

export interface RegisteredTool {
  name: string;
  description?: string;
  operation?: string;
  method?: string;
  path?: string;
  readOnly?: boolean;
  status?: 'enabled' | 'not_selected' | 'write_disabled';
}

export interface ManifestPreview {
  manifest: string;
  permissions: Permission[];
}

export interface RegistrationResult {
  id: string;
  kind: 'tool';
  version: string;
  contractTests: ContractTest[];
  synced: boolean;
  syncError?: string;
  changedBy: LoggedChange;
  writesApproval?: { request: string; state: ApprovalRequest['state'] };
}

export type ProposalState = 'pending' | 'sent_for_approval' | 'approved' | 'rejected';

export interface ProposalMapping {
  table: string;
  becomes: 'document' | 'field' | 'attachment' | 'excluded';
  fields?: string[];
  reason?: string;
}

export type ConnectorOperator =
  'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_null' | 'not_null';

export interface ConnectorCondition {
  column: string;
  op: ConnectorOperator;
  value?: string | number | boolean | (string | number)[];
}

export interface ConnectorSource {
  engine?: 'postgres';
  host?: string;
  database?: string;
  schema?: string;
  table: string;
  fields: {
    id: string;
    title: string;
    text: string[];
    url?: string;
    date?: string;
    metadata?: string[];
  };
  filter?: ConnectorCondition[];
}

export interface ConnectionInput {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  tls?: boolean;
}

export interface ConnectionCheckFailure {
  path: string;
  message: string;
  code?: 'auth' | 'table' | 'columns';
  missing?: string[];
  known?: string[];
}

export type HostNetwork = 'public' | 'private' | 'blocked' | 'unknown';

export interface HostReach {
  host: string;
  network: HostNetwork;
  allowed: boolean;
  message?: string;
}

export interface PrivateNetworks {
  tenant: string;
  entries: string[];
  changedBy?: string;
  changedAt?: string;
  reason?: string;
}

export type ConnectorStatus = 'not_connected' | 'not_synced' | 'syncing' | 'connected' | 'failed';

export interface ConnectorView {
  id: string;
  name: string;
  service: string;
  proposal: string;
  approvedBy: string;
  approvedAt: string;
  status: ConnectorStatus;
  dataset?: string;
  connection?: {
    engine: 'postgres';
    host: string;
    port: number;
    database: string;
    user: string;
    tls: boolean;
    credentials: 'stored';
    network?: HostNetwork;
    networkAllowed?: boolean;
  };
  source?: ConnectorSource;
  lastSync: {
    status: 'running' | 'succeeded' | 'failed';
    startedAt: string;
    endedAt?: string;
    rows?: number;
    skipped?: number;
    error?: string;
  } | null;
}

export interface PlatformChange {
  summary: string;
  caseId: string;
  status: 'sent' | 'under_review' | 'planned' | 'rejected';
  rejectionReason?: string;
}

export interface CatalogProposal {
  id: string;
  level: 1 | 2 | 3 | 4;
  createdBy: 'assistant';
  requestedBy?: string;
  forService: BlockUser;
  createdAt: string;
  item?: CatalogItem;
  mapping?: ProposalMapping[];
  source?: ConnectorSource;
  permissions: Permission[];
  tests: ContractTest[];
  quality?: string;
  state: ProposalState;
  platformChange?: PlatformChange;
  decision?: LoggedChange;
}

export interface ProposalDecision {
  proposal: CatalogProposal;
  changedBy: LoggedChange;
}

export interface BlockFilter {
  kind?: BlockKind;
  status?: BlockStatus;
  publisher?: CatalogItem['publisher']['type'];
}

export const buildingBlocksPath = (ctx: ApiContext, tenant: string, rest = '') =>
  `${ctx.tenantPath(tenant)}/building-blocks${rest}`;

export const blockPath = (block: Pick<CatalogItem, 'kind' | 'id'>, rest = '') =>
  `/${block.kind}/${encodeURIComponent(block.id)}${rest}`;

export const blockHref = (block: Pick<CatalogItem, 'kind' | 'id'>) =>
  `#/building-blocks${blockPath(block)}`;

export const changeOf = (result: BlockChangeResult): LoggedChange | undefined =>
  result.block.changedBy;

export const requestChange = (request: ApprovalRequest): LoggedChange => ({
  by: request.requestedBy,
  at: request.requestedAt,
  reason: request.reason,
});

const reasonHeader = (reason: string) => ({ 'change-reason': reason.trim() });

export const readable = (item: CatalogItem): CatalogItem =>
  item.kind === 'model' && item.name === item.id ? { ...item, name: modelLabel(item.id) } : item;

export const buildingBlocksApi = (ctx: ApiContext) => {
  const at = (tenant: string, rest = '') => buildingBlocksPath(ctx, tenant, rest);
  const proposalsAt = (tenant: string, rest = '') => `${ctx.tenantPath(tenant)}/proposals${rest}`;
  type Ref = Pick<CatalogItem, 'kind' | 'id'>;
  return {
    path: at,
    list: async (tenant: string, filter: BlockFilter = {}, signal?: AbortSignal) => {
      const query = new URLSearchParams();
      if (filter.kind) query.set('kind', filter.kind);
      if (filter.status) query.set('status', filter.status);
      if (filter.publisher) query.set('publisher', filter.publisher);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      const list = await ctx.get<BuildingBlockList>(at(tenant, suffix), signal);
      return { ...list, data: list.data.map(readable) };
    },
    get: async (tenant: string, block: Ref, signal?: AbortSignal) =>
      readable(await ctx.get<CatalogItem>(at(tenant, blockPath(block)), signal)),
    versions: async (tenant: string, block: Ref, signal?: AbortSignal) =>
      (await ctx.get<{ data: BlockVersion[] }>(at(tenant, blockPath(block, '/versions')), signal))
        .data,
    adopt: (tenant: string, block: Ref, reason: string) =>
      ctx.request<BlockChangeResult>(
        'POST',
        at(tenant, blockPath(block, '/adopt')),
        {},
        reasonHeader(reason),
      ),
    requestApproval: (tenant: string, block: Ref, reason: string) =>
      ctx.request<ApprovalRequest>(
        'POST',
        at(tenant, blockPath(block, '/approval-requests')),
        {},
        reasonHeader(reason),
      ),
    saveSettings: (
      tenant: string,
      block: Pick<CatalogItem, 'kind' | 'id' | 'settingsVersion'>,
      settings: Record<string, SettingValue | null>,
      reason: string,
    ) =>
      ctx.request<BlockChangeResult>(
        'PUT',
        at(tenant, blockPath(block, '/settings')),
        { settings },
        { ...reasonHeader(reason), 'if-match': String(block.settingsVersion) },
      ),
    secrets: async (tenant: string, signal?: AbortSignal) =>
      (await ctx.get<{ data: TenantSecretName[] }>(at(tenant, '/secrets'), signal)).data,
    contractTest: (tenant: string, input: RegistrationInput) =>
      ctx.request<ContractTestReport>('POST', at(tenant, '/contract-tests'), input),
    manifestPreview: (tenant: string, input: RegistrationInput) =>
      ctx.request<ManifestPreview>('POST', at(tenant, '/manifest-preview'), input),
    register: (tenant: string, input: RegistrationInput, reason: string) =>
      ctx.request<RegistrationResult>('POST', at(tenant), input, reasonHeader(reason)),
    proposalsPath: proposalsAt,
    proposals: async (tenant: string, signal?: AbortSignal) => {
      const byState = (state: ProposalState) =>
        ctx.get<{ data: CatalogProposal[] }>(proposalsAt(tenant, `?state=${state}`), signal);
      const lists = await Promise.all([byState('pending'), byState('sent_for_approval')]);
      return lists
        .flatMap((l) => l.data)
        .filter((p) => p.level === 2 || p.level === 3)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    decideProposal: (
      tenant: string,
      id: string,
      action: 'approve' | 'reject' | 'send-for-approval',
      reason: string,
      connection?: ConnectionInput,
    ) =>
      ctx.request<ProposalDecision>(
        'POST',
        proposalsAt(tenant, `/${encodeURIComponent(id)}/${action}`),
        { reason: reason.trim(), ...(connection ? { connection } : {}) },
        reasonHeader(reason),
      ),
    connectorsPath: (tenant: string, rest = '') => `${ctx.tenantPath(tenant)}/connectors${rest}`,
    connectors: async (tenant: string, signal?: AbortSignal) =>
      (await ctx.get<{ data: ConnectorView[] }>(`${ctx.tenantPath(tenant)}/connectors`, signal))
        .data,
    connectorNetwork: (tenant: string, host: string, signal?: AbortSignal) =>
      ctx.get<HostReach>(
        `${ctx.tenantPath(tenant)}/connectors/network?host=${encodeURIComponent(host)}`,
        signal,
      ),
    privateNetworks: (tenant: string, signal?: AbortSignal) =>
      ctx.get<PrivateNetworks>(`${ctx.tenantPath(tenant)}/private-networks`, signal),
    changeConnectorPassword: (tenant: string, id: string, password: string, reason: string) =>
      ctx.request<ConnectorView>(
        'PUT',
        `${ctx.tenantPath(tenant)}/connectors/${encodeURIComponent(id)}/credentials`,
        { password },
        reasonHeader(reason),
      ),
    syncConnector: (tenant: string, id: string, reason: string) =>
      ctx.request<ConnectorView>(
        'POST',
        `${ctx.tenantPath(tenant)}/connectors/${encodeURIComponent(id)}/sync`,
        {},
        reasonHeader(reason),
      ),
  };
};
