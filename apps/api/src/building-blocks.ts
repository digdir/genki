import type { Principal } from '@genai/contracts';
import {
  adoptionKind,
  attachRuntimeBlocks,
  blockKey,
  blockSettings,
  runtimeBlocksKey,
  runtimeBlocksOf,
  withBlockSettings as withBlockSettingsFor,
  type BlockTexts,
  type RuntimeBlock,
  type RuntimeBlocks,
} from '@genai/composition';
import {
  type ServiceDefinition,
  type SkillDefinition,
  type StepFlowDefinition,
  type ValidationError,
} from '@genai/definitions';
import { bundledJudge, runState, type StoredRun } from '@genai/eval';
import { type SecretResolver, type Strategy } from '@genai/kernel';
import { residencies, type Residency } from '@genai/port-model';
import {
  A2aClient,
  jsonRpcInterface,
  pinnedFromCard,
  type AgentCard,
} from '@genai/providers-a2a-client';
import {
  EgressError,
  EgressGuard,
  McpClient,
  RegistrationError,
  secretTargets,
  TenantSecrets,
  toolSlug,
  validateConnection,
  type Connection,
  type RemoteTool,
} from '@genai/providers-mcp-client';
import {
  loadDocument,
  operationsOf,
  operationStatus,
  type Operation,
  type OperationStatus,
} from '@genai/providers-openapi-tools';
import type { Context, Env, Hono, Schema } from 'hono';
import { stringify as toYaml } from 'yaml';
import { actorOf, type AdminHandler, type AdminOutcome } from './admin.js';
import { tenantServiceUses, type BlockReference, type ServiceUse } from './block-usage.js';
import {
  appendVersion,
  platformScope,
  serialized,
  VersionConflict,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';
import type {
  ModuleDeps,
  MountDeps,
  PlatformModule,
  PlatformModuleFactory,
} from './platform-modules.js';
import { requireRight, rightRefused, type Right } from './rights.js';
import { pluginBlockOf, pluginEntries } from './external-plugins.js';
import { actorNameOf, changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { requestLocale, t, translate, translatorFor, type ApiKey } from './i18n/index.js';

export const blockKinds = [
  'model',
  'dataset',
  'search_engine',
  'tool',
  'skill',
  'extension_point',
  'guardrail',
  'judge',
  'step_flow',
  'shared_service',
] as const;
export type BlockKind = (typeof blockKinds)[number];

export const blockStatuses = [
  'in_use',
  'available',
  'requires_approval',
  'pending_approval',
  'not_allowed',
] as const;
export type BlockStatus = (typeof blockStatuses)[number];

export type DataLocation = Residency;
export type PublisherType = 'digdir' | 'own' | 'shared';

export interface BlockPublisher {
  type: PublisherType;
  name: string;
}

export interface BlockPermission {
  type: 'network' | 'secret' | 'data' | 'model';
  value: string;
  note: string;
}

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

export interface PolicyBlock {
  rule: string;
  ownedBy: string;
  text: string;
}

export interface SettingSchema {
  type: 'boolean' | 'integer' | 'number' | 'string';
  title: string;
  description?: string;
  default: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  'x-unit'?: string;
}

export interface SettingsSchema {
  type: 'object';
  properties: Record<string, SettingSchema>;
  additionalProperties: false;
}

export interface PendingRequest {
  id: string;
  at: string;
  by: string;
  reason: string;
}

export interface BuildingBlock {
  id: string;
  kind: BlockKind;
  name: string;
  description: string;
  publisher: BlockPublisher;
  version: string;
  latestVersion?: string;
  update?: BlockUpdate;
  dataLocation: DataLocation | null;
  status: BlockStatus;
  policyBlock?: PolicyBlock;
  approver?: string;
  capabilities: string[];
  permissions: BlockPermission[];
  usedBy: BlockUser[];
  scores: BlockScore[];
  settingsSchema: SettingsSchema;
  tenantOverrides: Record<string, unknown>;
  settingsVersion: number;
  right: Extract<Right, 'manage-services' | 'manage-datasets'>;
  changedBy?: { by: string; at: string; reason: string };
  pendingRequest?: PendingRequest;
}

export interface BuildingBlockList {
  data: BuildingBlock[];
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
  block: BuildingBlock;
  version: number;
  changes: SettingChange[];
  affectedServices: BlockUser[];
}

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ApprovalRequest {
  id: string;
  tenant: string;
  kind: BlockKind;
  block: string;
  blockName: string;
  approver: string;
  state: ApprovalState;
  reason: string;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
  grants?: 'writes';
  decision?: { by: string; byName?: string; at: string; reason: string };
}

export type PolicyEffect = 'requires_approval' | 'not_allowed';

export interface PolicyRule {
  id: string;
  match: { kind?: BlockKind; residency?: DataLocation[]; id?: string };
  effect: PolicyEffect;
  ownedBy: string;
  text: string;
  approver?: 'digdir' | 'tenant';
}

export const registrationTypes = [
  'mcp',
  'openapi',
  'a2a',
  'extension_point',
  'skill_package',
] as const;
export type RegistrationType = (typeof registrationTypes)[number];

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
  extensionPoint?: string;
  document?: string;
  documentUrl?: string;
  operations?: string[];
  writes?: boolean;
}

export interface ContractTestResult {
  name: string;
  passed: boolean;
  reason?: string;
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
  results: ContractTestResult[];
  tools: RegisteredToolPreview[];
  agent?: AgentCardSummary;
}

export interface RegisteredToolPreview {
  name: string;
  description?: string;
  operation?: string;
  method?: string;
  path?: string;
  readOnly?: boolean;
  status?: OperationStatus;
}

export interface ManifestPreview {
  manifest: string;
  permissions: BlockPermission[];
}

export interface RegistrationResult {
  id: string;
  kind: 'tool';
  version: string;
  contractTests: ContractTestResult[];
  synced: boolean;
  syncError?: string;
  changedBy: { by: string; at: string; reason: string };
  writesApproval?: { request: string; state: ApprovalState };
}

const typeNames: Partial<Record<RegistrationType, ApiKey>> = {
  mcp: 'blocks.typeMcp',
  a2a: 'blocks.typeA2a',
  openapi: 'blocks.typeOpenapi',
};

const extensionPointLabels: Record<string, ApiKey> = {
  before_search: 'blocks.pointBeforeSearch',
  after_search: 'blocks.pointAfterSearch',
  before_model: 'blocks.pointBeforeModel',
  after_model: 'blocks.pointAfterModel',
  before_tool: 'blocks.pointBeforeTool',
  on_publish: 'blocks.pointOnPublish',
  on_feedback: 'blocks.pointOnFeedback',
};

export const policyKind = 'block-policy';
export const approvalKind = 'block-approval-request';

export const outsideEuText =
  'Ikke tillatt: data behandles utenfor EU/EØS. Digdir kan endre dette i plattforminnstillingene.';

export const outsideEuRule: PolicyRule = {
  id: 'models-outside-eu-eea',
  match: { kind: 'model', residency: ['global'] },
  effect: 'not_allowed',
  ownedBy: 'digdir',
  text: outsideEuText,
};

export const defaultPolicy: PolicyRule[] = [];

export interface AdoptionSpec {
  status: 'in_use' | 'pending_approval';
  settings: Record<string, unknown>;
  approvedBy?: string;
  request?: string;
  event: BlockEvent;
  changes?: SettingChange[];
}

type Guard = Pick<EgressGuard, 'request'>;

export interface BuildingBlocksOptions {
  guard?: Guard;
  secrets?: SecretResolver;
  secretNames?: (tenant: string) => Promise<string[]>;
  now?: () => Date;
  newId?: () => string;
}

interface Source {
  block: Omit<
    BuildingBlock,
    'status' | 'usedBy' | 'scores' | 'tenantOverrides' | 'settingsVersion' | 'right'
  >;
  owner?: string;
  latest?: { version: number; at: string; reason: string };
  uses(ref: BlockReference): boolean;
  history(): Promise<BlockVersion[]>;
}

const locationOf = (residency: unknown): DataLocation | null =>
  residencies.includes(residency as Residency) ? (residency as Residency) : null;

export interface BlockPolicy {
  tenant: string;
  rules: PolicyRule[];
  adoptions: Map<string, ConfigEntry<AdoptionSpec>>;
}

export interface PolicySubject {
  kind: BlockKind;
  id: string;
  dataLocation: DataLocation | null;
}

export interface BlockPolicyStatus {
  status: BlockStatus;
  blocked?: PolicyRule;
  approval?: PolicyRule;
  approver?: string;
  adoption?: ConfigEntry<AdoptionSpec>;
}

export const readBlockPolicy = async (
  configEntries: Pick<ConfigEntryStore, 'latest'>,
  tenant: string,
): Promise<BlockPolicy> => {
  const [platformEntries, tenantEntries, adopted] = await Promise.all([
    configEntries.latest({ kind: policyKind, scope: platformScope }),
    configEntries.latest({ kind: policyKind, scope: tenant }),
    configEntries.latest({ kind: adoptionKind, scope: tenant }),
  ]);
  const rulesOf = (entries: ConfigEntry<unknown>[]) =>
    entries
      .filter((e) => !e.deleted)
      .flatMap((e) => (e.spec as { rules?: PolicyRule[] }).rules ?? []);
  return {
    tenant,
    rules: [
      ...(platformEntries.length ? rulesOf(platformEntries) : defaultPolicy),
      ...rulesOf(tenantEntries),
    ],
    adoptions: new Map(
      adopted.filter((e) => !e.deleted).map((e) => [e.id, e as ConfigEntry<AdoptionSpec>]),
    ),
  };
};

export const blockStatusFor = (
  policy: BlockPolicy,
  subject: PolicySubject,
  context: { used?: boolean; owner?: string } = {},
): BlockPolicyStatus => {
  const matching = policy.rules.filter(
    (r) =>
      (r.match.kind === undefined || r.match.kind === subject.kind) &&
      (r.match.id === undefined || r.match.id === subject.id) &&
      (r.match.residency === undefined ||
        (subject.dataLocation !== null && r.match.residency.includes(subject.dataLocation))),
  );
  const blocked = matching.find((r) => r.effect === 'not_allowed');
  const approval = matching.find((r) => r.effect === 'requires_approval');
  const adoption = policy.adoptions.get(blockKey(subject.kind, subject.id));
  const approver = approval
    ? approval.approver === 'tenant'
      ? (context.owner ?? policy.tenant)
      : 'digdir'
    : undefined;
  const status: BlockStatus = blocked
    ? 'not_allowed'
    : adoption?.spec.status === 'pending_approval'
      ? 'pending_approval'
      : approval && !(adoption?.spec.status === 'in_use' && adoption.spec.approvedBy)
        ? 'requires_approval'
        : adoption?.spec.status === 'in_use' || context.used
          ? 'in_use'
          : 'available';
  return {
    status,
    ...(blocked ? { blocked } : {}),
    ...(approval ? { approval } : {}),
    ...(approver ? { approver } : {}),
    ...(adoption ? { adoption } : {}),
  };
};

const enabledSetting = (): SettingSchema => ({
  type: 'boolean',
  title: t('blocks.enabledTitle'),
  description: t('blocks.enabledDescription'),
  default: true,
});

const settingsOf = (extra: Record<string, SettingSchema> = {}): SettingsSchema => ({
  type: 'object',
  properties: { enabled: enabledSetting(), ...extra },
  additionalProperties: false,
});

const noSettings: SettingsSchema = { type: 'object', properties: {}, additionalProperties: false };

const rightFor = (kind: BlockKind): BuildingBlock['right'] =>
  kind === 'dataset' || kind === 'search_engine' ? 'manage-datasets' : 'manage-services';

const hostOf = (url: unknown) => {
  if (typeof url !== 'string' || !URL.canParse(url)) return undefined;
  return new URL(url).host;
};

const scoreOf = (stored: StoredRun) => {
  const means = Object.values(stored.run.metrics).map((m) => m.mean);
  return means.length === 0
    ? undefined
    : Math.round((means.reduce((a, b) => a + b, 0) / means.length) * 100);
};

/** The latest completed run per service and test set: one still running or failed scores nothing. */
const latestRuns = (runs: StoredRun[]) => {
  const latest = new Map<string, StoredRun>();
  for (const stored of runs) {
    if (runState(stored.run) !== 'completed') continue;
    const key = `${stored.service ?? stored.run.capability}|${stored.run.testSet.id}`;
    const known = latest.get(key);
    if (!known || known.run.endedAt < stored.run.endedAt) latest.set(key, stored);
  }
  return [...latest.values()];
};

const scoresFrom = (runs: StoredRun[]): BlockScore[] =>
  latestRuns(runs).flatMap((stored) => {
    const score = scoreOf(stored);
    return score === undefined
      ? []
      : [
          {
            testSet: stored.run.testSet.id,
            service: stored.service ?? stored.run.capability,
            score,
            run: stored.run.id,
            at: stored.run.endedAt,
          },
        ];
  });

const fromEntries = (entries: ConfigEntry<unknown>[]): BlockVersion[] =>
  entries.map((e) => ({
    source: 'publisher',
    version: String(e.version),
    at: e.at,
    by: e.by,
    reason: e.reason,
  }));

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'byggekloss';

const tenantSecretRef = (tenant: string, secret: string) =>
  secret.startsWith('secret://') ? secret : `secret://tenant/${tenant}/${secret}`;

const tenantSecretPrefix = (tenant: string) => `secret://tenant/${tenant}/`;

export interface TenantSecretName {
  name: string;
  ref: string;
  allowedHosts: string[];
}

const checkSetting = (key: string, schema: SettingSchema | undefined, value: unknown) => {
  if (!schema) return `${key} is not a setting of this building block`;
  if (schema.type === 'boolean')
    return typeof value === 'boolean' ? undefined : 'must be true or false';
  if (schema.type === 'string') {
    if (typeof value !== 'string') return 'must be text';
    return schema.enum && !schema.enum.includes(value)
      ? `must be one of ${schema.enum.join(', ')}`
      : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
  if (schema.type === 'integer' && !Number.isInteger(value)) return 'must be a whole number';
  if (schema.minimum !== undefined && value < schema.minimum)
    return `must be at least ${schema.minimum}`;
  if (schema.maximum !== undefined && value > schema.maximum)
    return `must be at most ${schema.maximum}`;
  return undefined;
};

export { adoptionKind, blockKey, runtimeBlocksKey };
export type { RuntimeBlock, RuntimeBlocks };

export const disabledBlockText = (name: string) => t('blocks.disabled', { name });

const platformText = (
  kind: 'flow' | 'block',
  id: string,
  field: 'Name' | 'Description',
  fallback: string,
) => {
  const camel = id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const translator = translatorFor(requestLocale());
  const key = `platformBlocks.${kind}${camel}${field}`;
  return translator.has(key) ? translate(key as ApiKey) : fallback;
};

const blockTexts: BlockTexts = {
  disabled: disabledBlockText,
  toolTimedOut: (seconds) => t('blocks.toolTimedOut', { seconds }),
};

export const withBlockSettings = <C>(
  configEntries: Pick<ConfigEntryStore, 'latest'>,
  inner: Strategy<C>,
): Strategy<C> => withBlockSettingsFor(configEntries, inner, blockTexts);

export interface BuildingBlocksModule extends PlatformModule {
  checkPublish(definition: unknown): Promise<ValidationError[]>;
}

export const createBuildingBlocksModule =
  (options: BuildingBlocksOptions = {}) =>
  (deps: ModuleDeps): BuildingBlocksModule => {
    const now = options.now ?? (() => new Date());
    const newId = options.newId ?? (() => crypto.randomUUID());
    const guard = options.guard ?? new EgressGuard();
    const secrets = new TenantSecrets(
      options.secrets ?? {
        resolve: async () => {
          throw new Error('secrets are not available for contract tests');
        },
      },
    );
    const writes = serialized();
    const digdir: BlockPublisher = { type: 'digdir', name: 'Digdir' };
    const publisherOf = (scope: string, tenant: string): BlockPublisher =>
      scope === platformScope || scope === deps.platformTenant
        ? digdir
        : scope === tenant
          ? { type: 'own', name: tenant }
          : { type: 'shared', name: scope };

    const datasetEndpoint = (id: string) => {
      const resolved = deps.knowledge.resolve(id) ?? id;
      return deps.catalog.get('dataset', resolved)?.spec.endpoint as string | undefined;
    };
    const sameDataset = (ref: string, id: string, tenant: string) =>
      (deps.knowledge.resolve(ref) ?? ref) === id || `${tenant}/${ref}` === id;

    const sources = async (tenant: string): Promise<Source[]> => {
      const out: Source[] = [];
      const shown = deps.catalog.visibleTo(tenant);
      const visible =
        tenant === deps.platformTenant
          ? [
              ...shown,
              ...deps.catalog
                .list({ kind: 'knowledge-endpoint' })
                .filter((e) => e.scope === platformScope && !shown.some((s) => s.id === e.id)),
            ]
          : shown;
      const catalogModels = new Map(
        visible.filter((i) => i.kind === 'model').map((i) => [i.id, i]),
      );
      for (const model of deps.models.describe()) {
        const item = catalogModels.get(model.id) ?? deps.catalog.get('model', model.id);
        if (!model.enabled) continue;
        if (item && !catalogModels.has(model.id)) continue;
        const scope = item?.scope ?? platformScope;
        out.push({
          block: {
            id: model.id,
            kind: 'model',
            name: model.id,
            description: model.family ?? model.deployment,
            publisher: publisherOf(scope, tenant),
            version: String(item?.version ?? 1),
            dataLocation: locationOf(model.residency),
            capabilities: [...model.capabilities],
            permissions: [{ type: 'model', value: model.id, note: model.residency }],
            settingsSchema: settingsOf(),
          },
          uses: (ref) => ref.kind === 'model' && ref.id === model.id,
          history: async () =>
            item ? fromEntries(await deps.catalog.history('model', model.id)) : [],
        });
      }
      const engines = new Map(deps.engines().map((e) => [e.engine, e]));
      for (const item of visible) {
        if (item.kind === 'dataset') {
          const spec = item.spec as { name?: string; description?: string; residency?: string };
          out.push({
            block: {
              id: item.id,
              kind: 'dataset',
              name: spec.name ?? item.id,
              description: spec.description ?? '',
              publisher: publisherOf(item.scope, tenant),
              version: String(item.version),
              dataLocation: locationOf(spec.residency),
              capabilities: Object.keys((item.spec.filters as object | undefined) ?? {}).map(
                (f) => `filter.${f}`,
              ),
              permissions: [{ type: 'data', value: spec.name ?? item.id, note: '' }],
              settingsSchema: settingsOf(),
            },
            uses: (ref) => ref.kind === 'dataset' && sameDataset(ref.id, item.id, tenant),
            history: async () => fromEntries(await deps.catalog.history('dataset', item.id)),
          });
        }
        if (item.kind === 'knowledge-endpoint') {
          const engine = engines.get(String(item.spec.engine));
          const host = hostOf(item.spec.baseURL);
          const auth = item.spec.auth as { secret?: string } | undefined;
          out.push({
            block: {
              id: item.id,
              kind: 'search_engine',
              name: (item.spec.name as string | undefined) ?? engine?.title ?? item.id,
              description: engine?.title ?? String(item.spec.engine),
              publisher: publisherOf(item.scope, tenant),
              version: String(item.version),
              dataLocation: locationOf(engine?.dataLocation),
              capabilities: [...(engine?.capabilities ?? [])],
              permissions: [
                ...(host ? [{ type: 'network' as const, value: host, note: '' }] : []),
                ...(auth?.secret
                  ? [{ type: 'secret' as const, value: auth.secret, note: '' }]
                  : []),
              ],
              settingsSchema: settingsOf(),
            },
            uses: (ref) => ref.kind === 'dataset' && datasetEndpoint(ref.id) === item.id,
            history: async () =>
              fromEntries(await deps.catalog.history('knowledge-endpoint', item.id)),
          });
        }
      }
      for (const state of await deps.connections.list(tenant)) {
        const connection = state.connection;
        const ownTimeout = Math.max(1, Math.round((connection.timeoutMs ?? 10_000) / 1000));
        out.push({
          block: {
            id: connection.id,
            kind: 'tool',
            name: connection.name,
            description: connection.endpoint,
            publisher: { type: 'own', name: tenant },
            version: connection.version,
            dataLocation: null,
            capabilities: state.tools.map((t) =>
              t.description ? `${t.name}: ${t.description}` : t.name,
            ),
            permissions: [
              ...connection.allow.map((a) => ({
                type: 'network' as const,
                value: a.port && a.port !== 443 ? `${a.host}:${a.port}` : a.host,
                note: '',
              })),
              ...(connection.auth
                ? [{ type: 'secret' as const, value: connection.auth.secret, note: '' }]
                : []),
            ],
            settingsSchema: settingsOf({
              timeoutSeconds: {
                type: 'integer',
                title: t('blocks.timeoutTitle'),
                description: t('blocks.timeoutDescription'),
                default: ownTimeout,
                minimum: 1,
                maximum: ownTimeout,
                'x-unit': t('blocks.seconds'),
              },
            }),
          },
          uses: (ref) => ref.kind === 'tool' && ref.id.startsWith(`${connection.id}.`),
          history: async () => [{ source: 'publisher', version: connection.version }],
        });
      }
      for (const plugin of await pluginEntries(deps.configEntries)) {
        const block = pluginBlockOf(plugin);
        const owner = plugin.shared?.tenant ?? deps.platformTenant;
        if (!block || owner === tenant || block.kind === 'dataset') continue;
        if (block.kind === 'model' && plugin.manifest.kind === 'model') continue;
        const m = plugin.manifest;
        out.push({
          block: {
            id: block.id,
            kind: block.kind,
            name: m.title,
            description: m.description,
            publisher: publisherOf(plugin.shared ? owner : platformScope, tenant),
            version: m.version,
            dataLocation: locationOf(m.dataLocation),
            capabilities: [...m.capabilities],
            permissions: [
              ...m.hosts.map((host) => ({ type: 'network' as const, value: host, note: '' })),
              ...m.secrets.map((secret) => ({ type: 'secret' as const, value: secret, note: '' })),
            ],
            settingsSchema: settingsOf(),
          },
          owner,
          uses: (ref) =>
            block.kind === 'tool'
              ? ref.kind === 'tool' && ref.id.startsWith(`${block.id}.`)
              : ref.id === block.id,
          history: async () => [{ source: 'publisher', version: m.version }],
        });
      }
      const definitionOwners = [...new Set([tenant, deps.platformTenant])];
      for (const owner of definitionOwners) {
        for (const entry of await deps.definitions.list(owner)) {
          if (entry.kind === 'Service') continue;
          const history = await deps.definitions.versions(entry.kind, owner, entry.id);
          const latest = history.at(-1);
          if (!latest) continue;
          const kind: BlockKind = entry.kind === 'Skill' ? 'skill' : 'step_flow';
          const definition = latest.definition as SkillDefinition | StepFlowDefinition;
          const spec = definition.spec as {
            description?: string;
            purpose?: string;
            tools?: string[];
          };
          const steps = (definition as StepFlowDefinition).spec.steps;
          const ownedByPlatform = owner === deps.platformTenant && kind === 'step_flow';
          out.push({
            block: {
              id: entry.id,
              kind,
              name: ownedByPlatform
                ? platformText('flow', entry.id, 'Name', definition.metadata.name ?? entry.id)
                : (definition.metadata.name ?? entry.id),
              description: ownedByPlatform
                ? platformText(
                    'flow',
                    entry.id,
                    'Description',
                    spec.description ?? spec.purpose ?? '',
                  )
                : (spec.description ?? spec.purpose ?? ''),
              publisher: publisherOf(owner, tenant),
              version: String(latest.version),
              dataLocation: null,
              capabilities:
                kind === 'skill' ? (spec.tools ?? []) : (steps ?? []).map((s) => s.name ?? s.id),
              permissions: [],
              settingsSchema: settingsOf(),
            },
            latest: { version: latest.version, at: latest.publishedAt, reason: latest.reason },
            uses: (ref) => ref.kind === kind && ref.id === entry.id,
            history: async () =>
              history.map((v) => ({
                source: 'publisher',
                version: String(v.version),
                at: v.publishedAt,
                by: v.publishedBy,
                reason: v.reason,
              })),
          });
        }
      }
      for (const ref of [...deps.plugins.blocks].sort()) {
        const id = ref.slice(0, ref.lastIndexOf('@'));
        out.push({
          block: {
            id: ref,
            kind: 'step_flow',
            name: platformText('block', id, 'Name', id),
            description: platformText('block', id, 'Description', ''),
            publisher: digdir,
            version: ref.slice(ref.lastIndexOf('@') + 1),
            dataLocation: null,
            capabilities: [],
            permissions: [],
            settingsSchema: settingsOf(),
          },
          uses: (r) => r.kind === 'step_flow' && r.ref === ref,
          history: async () => [],
        });
      }
      for (const id of [...deps.plugins.guardrails.keys()].filter((g) => g !== 'custom-rules'))
        out.push({
          block: {
            id,
            kind: 'guardrail',
            name: id,
            description: '',
            publisher: digdir,
            version: '1',
            dataLocation: null,
            capabilities: [],
            permissions: [],
            settingsSchema: settingsOf(),
          },
          uses: (ref) => ref.kind === 'guardrail' && ref.id === id,
          history: async () => [],
        });
      for (const scope of [platformScope, tenant]) {
        for (const entry of await deps.configEntries.latest({ kind: 'guardrail-rule', scope })) {
          if (entry.deleted) continue;
          const ruleId = scope === platformScope ? entry.id : entry.id.slice(scope.length + 1);
          const spec = (entry.spec as { spec?: { kind?: string; message?: string } }).spec ?? {};
          const id = `custom-rules/${ruleId}`;
          out.push({
            block: {
              id,
              kind: 'guardrail',
              name: ruleId,
              description: spec.message ?? '',
              publisher: publisherOf(scope, tenant),
              version: String(entry.version),
              dataLocation: null,
              capabilities: spec.kind ? [spec.kind] : [],
              permissions: [],
              settingsSchema: settingsOf(),
            },
            uses: (ref) => ref.kind === 'guardrail' && ref.id === id,
            history: async () =>
              fromEntries(await deps.configEntries.history('guardrail-rule', scope, entry.id)),
          });
        }
      }
      const judgeIds = new Set<string>(['answer-quality', 'pairwise-preference']);
      for (const stored of await deps.evalStores.runs.list({ tenant }))
        for (const judge of stored.run.provenance.judges) judgeIds.add(judge);
      for (const id of [...judgeIds].sort()) {
        const bundled =
          id === 'answer-quality' || id === 'pairwise-preference' ? bundledJudge(id) : undefined;
        out.push({
          block: {
            id,
            kind: 'judge',
            name: id,
            description: '',
            publisher: digdir,
            version: bundled?.version ?? '1',
            dataLocation: null,
            capabilities: bundled?.criteria.map((c) => c.description) ?? [],
            permissions: [],
            settingsSchema: noSettings,
          },
          uses: () => false,
          history: async () => [],
        });
      }
      const shared = new Map<
        string,
        {
          compiled: Awaited<ReturnType<typeof deps.definitions.capabilities>>[number];
          names: Set<string>;
        }
      >();
      for (const compiled of await deps.definitions.capabilities()) {
        if (compiled.service.tenant === tenant) continue;
        const availableTo = compiled.capability.descriptor.availableTo;
        if (availableTo !== '*' && !(Array.isArray(availableTo) && availableTo.includes(tenant)))
          continue;
        const key = `${compiled.service.tenant}/${compiled.service.id}`;
        const known = shared.get(key);
        if (known && known.compiled.service.version > compiled.service.version) continue;
        const entry =
          known && known.compiled.service.version === compiled.service.version
            ? known
            : { compiled, names: new Set<string>() };
        entry.names.add(compiled.publicName);
        for (const alias of compiled.aliases) entry.names.add(alias);
        shared.set(key, entry);
      }
      for (const [key, { compiled, names }] of shared) {
        const found = await deps.definitions.get(
          'Service',
          compiled.service.tenant,
          compiled.service.id,
        );
        const spec = (found?.definition as ServiceDefinition | undefined)?.spec;
        out.push({
          block: {
            id: key,
            kind: 'shared_service',
            name: compiled.capability.descriptor.title,
            description: compiled.capability.descriptor.description,
            publisher: publisherOf(compiled.service.tenant, tenant),
            version: String(compiled.service.version),
            dataLocation: locationOf(spec?.model.residency),
            capabilities: spec ? [spec.purpose] : [],
            permissions: [],
            settingsSchema: settingsOf(),
          },
          owner: compiled.service.tenant,
          uses: (ref) => ref.kind === 'tool' && names.has(ref.id),
          history: async () =>
            (
              await deps.definitions.versions(
                'Service',
                compiled.service.tenant,
                compiled.service.id,
              )
            ).map((v) => ({
              source: 'publisher',
              version: String(v.version),
              at: v.publishedAt,
              by: v.publishedBy,
              reason: v.reason,
            })),
        });
      }
      return out;
    };

    const adoptions = async (tenant: string) =>
      (await readBlockPolicy(deps.configEntries, tenant)).adoptions;

    const sharedToolNames = async (tenant: string) => {
      const names = new Map<string, string>();
      for (const compiled of await deps.definitions.capabilities()) {
        if (compiled.service.tenant === tenant) continue;
        const availableTo = compiled.capability.descriptor.availableTo;
        if (availableTo !== '*' && !(Array.isArray(availableTo) && availableTo.includes(tenant)))
          continue;
        const key = `${compiled.service.tenant}/${compiled.service.id}`;
        for (const name of [compiled.publicName, ...compiled.aliases]) names.set(name, key);
      }
      return names;
    };

    const runtimeBlocks = (definition: ServiceDefinition): Promise<RuntimeBlock[]> =>
      runtimeBlocksOf(definition, {
        flowSteps: async (tenant, flow) =>
          (
            (await deps.definitions.get('StepFlow', tenant, flow.id, flow.version))?.definition as
              { spec?: { steps?: unknown[] } } | undefined
          )?.spec?.steps ?? [],
        resolveDataset: (id) => deps.knowledge.resolve(id) ?? id,
        datasetEndpoint,
        sharedTools: sharedToolNames,
      });

    const isService = (definition: unknown): definition is ServiceDefinition => {
      const d = definition as Partial<ServiceDefinition> | undefined;
      return d?.kind === 'Service' && typeof d.metadata?.tenant === 'string' && !!d.spec;
    };

    const decorateCapability: NonNullable<PlatformModule['decorateCapability']> = async (
      capability,
      context,
    ) => {
      if (!isService(context.definition)) return capability;
      const blocks = await runtimeBlocks(context.definition);
      if (blocks.length === 0) return capability;
      return attachRuntimeBlocks(capability, context.definition.metadata.tenant, blocks);
    };

    const checkPublish = async (definition: unknown): Promise<ValidationError[]> => {
      if (!isService(definition)) return [];
      const settings = await blockSettings(deps.configEntries, definition.metadata.tenant);
      if (![...settings.values()].some((s) => s.enabled === false)) return [];
      const seen = new Set<string>();
      return (await runtimeBlocks(definition)).flatMap((b) => {
        if (settings.get(b.key)?.enabled !== false || seen.has(b.key)) return [];
        seen.add(b.key);
        return [{ path: b.path, message: disabledBlockText(b.name) }];
      });
    };

    const requests = async (scope?: string): Promise<ApprovalRequest[]> =>
      (await deps.configEntries.latest({ kind: approvalKind, ...(scope ? { scope } : {}) })).map(
        (e) => e.spec as ApprovalRequest,
      );

    const keyOf = blockKey;

    const assemble = async (tenant: string): Promise<BuildingBlock[]> => {
      const [all, uses, runs, policy, pending] = await Promise.all([
        sources(tenant),
        tenantServiceUses(deps.definitions, tenant),
        deps.evalStores.runs.list({ tenant }),
        readBlockPolicy(deps.configEntries, tenant),
        requests(tenant),
      ]);
      return all.map((source) => assembleOne(source, uses, runs, policy, pending));
    };

    const assembleOne = (
      source: Source,
      uses: ServiceUse[],
      runs: StoredRun[],
      policy: BlockPolicy,
      pending: ApprovalRequest[],
    ): BuildingBlock => {
      const { block } = source;
      const using = uses
        .map((u) => ({ use: u, refs: u.references.filter((r) => source.uses(r)) }))
        .filter((u) => u.refs.length > 0);
      const judged =
        block.kind === 'judge'
          ? new Set(
              runs
                .filter((r) => r.run.provenance.judges.includes(block.id))
                .map((r) => r.service ?? r.run.capability),
            )
          : new Set<string>();
      const usedBy: BlockUser[] = [
        ...using.map(({ use, refs }) => {
          const pinned = refs.map((r) => r.version).filter((v): v is number => v !== undefined);
          return {
            id: use.service,
            name: use.name,
            ...(pinned.length > 0 ? { version: Math.min(...pinned) } : {}),
          };
        }),
        ...[...judged]
          .filter((s) => !using.some((u) => u.use.service === s))
          .map((s) => ({ id: s, name: uses.find((u) => u.service === s)?.name ?? s })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      const users = new Set(usedBy.map((u) => u.id));
      const scores = scoresFrom(
        runs.filter((r) =>
          block.kind === 'model'
            ? r.run.provenance.servedModels.includes(block.id)
            : block.kind === 'judge'
              ? r.run.provenance.judges.includes(block.id)
              : users.has(r.service ?? ''),
        ),
      );
      const serviceScore = (service: string) =>
        scoresFrom(runs.filter((r) => r.service === service))[0]?.score ?? null;
      let version = block.version;
      let latestVersion: string | undefined;
      let update: BlockUpdate | undefined;
      if (source.latest) {
        const pinned = usedBy.map((u) => u.version).filter((v): v is number => v !== undefined);
        const inUse = pinned.length > 0 ? Math.min(...pinned) : source.latest.version;
        version = String(inUse);
        if (inUse < source.latest.version) {
          latestVersion = String(source.latest.version);
          update = {
            version: latestVersion,
            availableFrom: source.latest.at,
            notes: source.latest.reason,
            perService: usedBy
              .filter((u) => u.version !== undefined && u.version < (source.latest?.version ?? 0))
              .map((u) => ({ service: u.id, scoreBefore: serviceScore(u.id), scoreAfter: null })),
          };
        }
      }
      const { status, blocked, approver, adoption } = blockStatusFor(policy, block, {
        used: usedBy.length > 0,
        ...(source.owner ? { owner: source.owner } : {}),
      });
      const request = pending.find(
        (r) => r.kind === block.kind && r.block === block.id && r.state === 'pending',
      );
      return {
        ...block,
        version,
        ...(latestVersion ? { latestVersion } : {}),
        ...(update ? { update } : {}),
        status,
        ...(blocked
          ? { policyBlock: { rule: blocked.id, ownedBy: blocked.ownedBy, text: blocked.text } }
          : {}),
        ...(approver ? { approver } : {}),
        usedBy,
        scores,
        tenantOverrides: adoption?.spec.settings ?? {},
        settingsVersion: adoption?.version ?? 0,
        right: rightFor(block.kind),
        ...(adoption
          ? { changedBy: { by: adoption.by, at: adoption.at, reason: adoption.reason } }
          : {}),
        ...(request
          ? {
              pendingRequest: {
                id: request.id,
                at: request.requestedAt,
                by: request.requestedBy,
                reason: request.reason,
              },
            }
          : {}),
      };
    };

    const find = async (tenant: string, kind: string, id: string) => {
      const source = (await sources(tenant)).find(
        (s) => s.block.kind === kind && s.block.id === id,
      );
      if (!source) return undefined;
      const [uses, runs, policy, pending] = await Promise.all([
        tenantServiceUses(deps.definitions, tenant),
        deps.evalStores.runs.list({ tenant }),
        readBlockPolicy(deps.configEntries, tenant),
        requests(tenant),
      ]);
      return {
        source,
        block: assembleOne(source, uses, runs, policy, pending),
        adoption: policy.adoptions.get(keyOf(kind, id)),
      };
    };

    const list = async (
      tenant: string,
      filter: {
        kind?: string | undefined;
        status?: string | undefined;
        publisher?: string | undefined;
      },
    ): Promise<BuildingBlockList> => {
      const all = await assemble(tenant);
      const data = all.filter(
        (b) =>
          (!filter.kind || b.kind === filter.kind) &&
          (!filter.status || b.status === filter.status) &&
          (!filter.publisher || b.publisher.type === filter.publisher),
      );
      const byKind = Object.fromEntries(blockKinds.map((k) => [k, 0])) as Record<BlockKind, number>;
      for (const b of all) byKind[b.kind] += 1;
      return {
        data,
        counts: {
          inUse: all.filter((b) => b.status === 'in_use').length,
          catalog: all.length,
          byKind,
        },
      };
    };

    const versions = async (tenant: string, kind: string, id: string) => {
      const found = await find(tenant, kind, id);
      if (!found) return undefined;
      const own = await deps.configEntries.history(adoptionKind, tenant, keyOf(kind, id));
      return [
        ...(await found.source.history()),
        ...own.map((e) => {
          const spec = e.spec as Partial<AdoptionSpec>;
          return {
            source: 'tenant' as const,
            version: String(e.version),
            at: e.at,
            by: e.by,
            reason: e.reason,
            ...(spec.event ? { event: spec.event } : {}),
            ...(spec.changes ? { changes: spec.changes } : {}),
          };
        }),
      ];
    };

    const failed = (target: string, path: string, message: string): AdminOutcome => ({
      ok: false,
      errors: [{ path, message }],
      target,
    });
    const actorName = (principal: Principal) => actorOf(principal.actor ?? principal);
    const forTenant = (principal: Principal, tenant: string) =>
      principal.kind === 'operator' || principal.tenant === tenant;

    const adopt = async (
      tenant: string,
      kind: string,
      id: string,
      spec: AdoptionSpec,
      by: string,
      reason: string,
      deleted = false,
      ifVersion?: number,
    ) =>
      appendVersion<AdoptionSpec>(deps.configEntries, {
        kind: adoptionKind,
        scope: tenant,
        id: keyOf(kind, id),
        spec,
        deleted,
        by,
        reason,
        at: now().toISOString(),
        ...(ifVersion === undefined ? {} : { ifVersion }),
      });

    const handlers: Record<string, AdminHandler> = {
      'platform.block.adopt': (input, principal) =>
        writes(async () => {
          const { tenant, reason } = input;
          const kind = String(input.kind);
          const id = String(input.id);
          const target = `building-block:${tenant}/${kind}:${id}`;
          if (!forTenant(principal, tenant))
            return failed(target, 'principal', 'only the tenant adopts building blocks');
          if (!isReasonLongEnough(reason)) return failed(target, 'reason', reasonTooShort);
          const found = await find(tenant, kind, id);
          if (!found) return failed(target, 'block', `no building block ${kind}:${id}`);
          if (found.block.status === 'not_allowed')
            return failed(target, 'status', found.block.policyBlock?.text ?? 'not allowed');
          if (
            found.block.status === 'requires_approval' ||
            found.block.status === 'pending_approval'
          )
            return failed(target, 'status', 'this building block needs approval first');
          const saved = await adopt(
            tenant,
            kind,
            id,
            {
              status: 'in_use',
              settings: found.adoption?.spec.settings ?? {},
              ...(found.adoption?.spec.approvedBy
                ? { approvedBy: found.adoption.spec.approvedBy }
                : {}),
              event: 'adopted',
            },
            actorName(principal),
            reason,
          );
          const after = await find(tenant, kind, id);
          return {
            ok: true,
            value: {
              block: after?.block,
              version: saved.version,
              changes: [],
              affectedServices: [],
            },
            target,
            audit: { after: { status: 'in_use' } },
          };
        }),
      'platform.block.request': (input, principal) =>
        writes(async () => {
          const { tenant, reason } = input;
          const target = `building-block-request:${tenant}`;
          if (!forTenant(principal, tenant))
            return failed(target, 'principal', 'only the tenant asks for approval');
          if (input.op === 'withdraw') {
            const rid = String(input.request);
            const history = await deps.configEntries.history(approvalKind, tenant, rid);
            const current = history.at(-1)?.spec as ApprovalRequest | undefined;
            if (!current || current.state !== 'pending')
              return failed(target, 'request', `no pending approval request ${rid}`);
            const withdrawn: ApprovalRequest = { ...current, state: 'withdrawn' };
            await appendVersion(deps.configEntries, {
              kind: approvalKind,
              scope: tenant,
              id: rid,
              spec: withdrawn,
              deleted: false,
              by: actorName(principal),
              reason,
              at: now().toISOString(),
            });
            const adopted = (await adoptions(tenant)).get(keyOf(current.kind, current.block));
            await adopt(
              tenant,
              current.kind,
              current.block,
              {
                status: 'pending_approval',
                settings: adopted?.spec.settings ?? {},
                event: 'withdrawn',
              },
              actorName(principal),
              reason,
              true,
            );
            return { ok: true, value: withdrawn, target: `${target}/${rid}` };
          }
          if (!isReasonLongEnough(reason)) return failed(target, 'reason', reasonTooShort);
          const kind = String(input.kind);
          const id = String(input.id);
          const found = await find(tenant, kind, id);
          if (!found) return failed(target, 'block', `no building block ${kind}:${id}`);
          const writes = input.op === 'writes';
          if (writes && (found.block.kind !== 'tool' || found.block.status === 'pending_approval'))
            return failed(target, 'status', `the building block is ${found.block.status}`);
          if (!writes && found.block.status !== 'requires_approval')
            return failed(target, 'status', `the building block is ${found.block.status}`);
          const at = now().toISOString();
          const request: ApprovalRequest = {
            id: newId(),
            tenant,
            kind: found.block.kind,
            block: id,
            blockName: found.block.name,
            approver: writes ? 'digdir' : (found.block.approver ?? 'digdir'),
            state: 'pending',
            ...(writes ? { grants: 'writes' as const } : {}),
            reason,
            requestedBy: actorName(principal),
            ...(typeof input.requestedByName === 'string'
              ? { requestedByName: input.requestedByName }
              : {}),
            requestedAt: at,
          };
          await appendVersion(deps.configEntries, {
            kind: approvalKind,
            scope: tenant,
            id: request.id,
            spec: request,
            deleted: false,
            by: request.requestedBy,
            reason,
            at,
          });
          await adopt(
            tenant,
            kind,
            id,
            {
              status: 'pending_approval',
              settings: found.adoption?.spec.settings ?? {},
              request: request.id,
              event: 'approval_requested',
            },
            request.requestedBy,
            reason,
          );
          return { ok: true, value: request, target: `${target}/${request.id}` };
        }),
      'platform.block.decide': (input, principal) =>
        writes(async () => {
          const rid = String(input.request);
          const target = `building-block-request:${rid}`;
          if (principal.kind !== 'operator')
            return failed(target, 'principal', 'only operators decide approval requests');
          const decision = input.decision;
          if (decision !== 'approved' && decision !== 'rejected')
            return failed(target, 'decision', 'must be approved or rejected');
          const entry = (await deps.configEntries.latest({ kind: approvalKind })).find(
            (e) => e.id === rid,
          );
          const current = entry?.spec as ApprovalRequest | undefined;
          if (!entry || !current || current.state !== 'pending')
            return failed(target, 'request', `no pending approval request ${rid}`);
          if (current.approver !== 'digdir')
            return failed(target, 'status', `${current.approver} approves this request`);
          const by = actorName(principal);
          const at = now().toISOString();
          const decided: ApprovalRequest = {
            ...current,
            state: decision,
            decision: {
              by,
              ...(typeof input.byName === 'string' && input.byName ? { byName: input.byName } : {}),
              at,
              reason: input.reason,
            },
          };
          await appendVersion(deps.configEntries, {
            kind: approvalKind,
            scope: entry.scope,
            id: rid,
            spec: decided,
            deleted: false,
            by,
            reason: input.reason,
            at,
          });
          const adopted = (await adoptions(current.tenant)).get(keyOf(current.kind, current.block));
          await adopt(
            current.tenant,
            current.kind,
            current.block,
            {
              status: 'in_use',
              settings: adopted?.spec.settings ?? {},
              ...(decision === 'approved' ? { approvedBy: by } : {}),
              request: rid,
              event: decision,
            },
            by,
            input.reason,
            decision === 'rejected',
          );
          return {
            ok: true,
            value: decided,
            target,
            audit: { scope: 'platform', tenant: current.tenant, after: { state: decision } },
          };
        }),
      'platform.block.settings': (input, principal) =>
        writes(async () => {
          const { tenant, reason } = input;
          const kind = String(input.kind);
          const id = String(input.id);
          const target = `building-block-settings:${tenant}/${kind}:${id}`;
          if (!forTenant(principal, tenant))
            return failed(target, 'principal', 'only the tenant changes its settings');
          const found = await find(tenant, kind, id);
          if (!found) return failed(target, 'block', `no building block ${kind}:${id}`);
          if (found.block.status !== 'in_use' && found.block.status !== 'pending_approval')
            return failed(target, 'status', `the building block is ${found.block.status}`);
          const patch = input.settings;
          if (!patch || typeof patch !== 'object' || Array.isArray(patch))
            return failed(target, 'settings', 'must be an object');
          const before = found.block.tenantOverrides;
          const next: Record<string, unknown> = { ...before };
          const errors = [];
          for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
            if (value === null) {
              Reflect.deleteProperty(next, key);
              continue;
            }
            const problem = checkSetting(key, found.block.settingsSchema.properties[key], value);
            if (problem) errors.push({ path: `settings.${key}`, message: problem });
            else next[key] = value;
          }
          if (errors.length > 0) return { ok: false, errors, target };
          const changes = [...new Set([...Object.keys(before), ...Object.keys(next)])]
            .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]))
            .map((key) => ({ key, before: before[key] ?? null, after: next[key] ?? null }));
          const ifVersion = typeof input.ifVersion === 'number' ? input.ifVersion : undefined;
          try {
            const saved = await adopt(
              tenant,
              kind,
              id,
              {
                status: found.adoption?.spec.status ?? 'in_use',
                settings: next,
                ...(found.adoption?.spec.approvedBy
                  ? { approvedBy: found.adoption.spec.approvedBy }
                  : {}),
                ...(found.adoption?.spec.request ? { request: found.adoption.spec.request } : {}),
                event: 'settings',
                changes,
              },
              actorName(principal),
              reason,
              false,
              ifVersion,
            );
            const after = await find(tenant, kind, id);
            const value: BlockChangeResult = {
              block: after?.block ?? found.block,
              version: saved.version,
              changes,
              affectedServices: found.block.usedBy,
            };
            return { ok: true, value, target, audit: { before, after: next } };
          } catch (error) {
            if (error instanceof VersionConflict)
              return { ...failed(target, 'if-match', error.message), conflict: true };
            throw error;
          }
        }),
    };

    const connectionFor = (tenant: string, input: RegistrationInput): Connection => {
      const endpoint = input.endpoint ?? '';
      const auth = input.auth;
      if (auth?.kind === 'maskinporten')
        throw new RegistrationError(
          `Innlogging med Maskinporten støttes ikke ennå for ${translate(typeNames[input.type] ?? 'blocks.typeFallback')}.`,
        );
      if (
        (auth?.kind === 'bearer' ||
          auth?.kind === 'api-key' ||
          auth?.kind === 'oauth-client-credentials') &&
        !auth.secret
      )
        throw new RegistrationError('Velg hemmeligheten som skal brukes til innlogging.');
      if (auth?.kind === 'oauth-client-credentials' && (!auth.tokenUrl || !auth.clientId))
        throw new RegistrationError('Skriv adressen til tokenendepunktet og klient-ID-en.');
      if (
        auth?.secret?.startsWith('secret://') &&
        !auth.secret.startsWith(tenantSecretPrefix(tenant))
      )
        throw new RegistrationError('Velg en av hemmelighetene til virksomheten.');
      if (input.type === 'openapi' && !input.document && !input.documentUrl)
        throw new RegistrationError('Velg en OpenAPI-fil eller skriv adressen til den.');
      const hosts = new Map<string, { host: string; port?: number }>();
      for (const address of [endpoint, input.documentUrl, auth?.tokenUrl]) {
        if (!address || !URL.canParse(address)) continue;
        const url = new URL(address);
        const host = url.hostname.replace(/^\[|\]$/g, '');
        hosts.set(`${host}:${url.port}`, { host, ...(url.port ? { port: Number(url.port) } : {}) });
      }
      const secret = tenantSecretRef(tenant, auth?.secret ?? '');
      return validateConnection({
        id: input.id ?? slugOf(input.name),
        tenant,
        name: input.name,
        ...(input.type === 'mcp' ? {} : { protocol: input.type }),
        endpoint,
        version: '1',
        allow: [...hosts.values()],
        ...(input.type === 'openapi'
          ? {
              ...(input.document ? { document: input.document } : {}),
              ...(input.documentUrl ? { documentUrl: input.documentUrl } : {}),
              ...(input.operations ? { operations: input.operations } : {}),
              writes: input.writes === true,
            }
          : {}),
        ...(auth?.kind === 'bearer'
          ? { auth: { kind: 'bearer', secret } }
          : auth?.kind === 'api-key'
            ? { auth: { kind: 'header', header: auth.header ?? 'x-api-key', secret } }
            : auth?.kind === 'oauth-client-credentials'
              ? {
                  auth: {
                    kind: 'oauth-client-credentials',
                    tokenUrl: auth.tokenUrl,
                    clientId: auth.clientId,
                    ...(auth.scope ? { scope: auth.scope } : {}),
                    secret,
                  },
                }
              : {}),
      });
    };

    const secretProblem = async (connection: Connection) => {
      if (!connection.auth) return undefined;
      const outside = await secrets.outside(
        connection.tenant,
        connection.auth.secret,
        secretTargets(connection),
      );
      return outside.length > 0
        ? t('blocks.secretNotForHosts', {
            secret: connection.auth.secret.split('/').pop() ?? '',
            hosts: outside.join(', '),
          })
        : undefined;
    };

    const egressFailure = (error: unknown, notRun: string) => {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof EgressError ? error.code : undefined;
      return {
        message,
        timeout:
          code === 'timeout'
            ? { passed: false, reason: message }
            : {
                passed: code !== undefined && code !== 'cancelled',
                ...(code ? {} : { reason: notRun }),
              },
        hosts:
          code === 'not_allowed' || code === 'redirect_refused' || code === 'private_address'
            ? { passed: false, reason: message }
            : { passed: code !== undefined, ...(code ? {} : { reason: notRun }) },
      };
    };

    const a2aContractTest = async (
      input: RegistrationInput,
      connection: Connection,
      signal?: AbortSignal,
    ): Promise<ContractTestReport> => {
      const names = {
        setup: t('blocks.testSetup'),
        card: t('blocks.testCard'),
        skills: t('blocks.testSkills'),
        timeout: t('blocks.testTimeout'),
        hosts: t('blocks.testHosts'),
      };
      const client = new A2aClient(connection, guard as EgressGuard, secrets);
      let card: AgentCard;
      try {
        card = await client.card(signal);
      } catch (error) {
        const failure = egressFailure(error, t('blocks.cardNotRead'));
        return {
          type: input.type,
          passed: false,
          results: [
            { name: names.setup, passed: true },
            { name: names.card, passed: false, reason: failure.message },
            {
              name: names.skills,
              passed: false,
              reason: t('blocks.cardNotRead'),
            },
            { name: names.timeout, ...failure.timeout },
            { name: names.hosts, ...failure.hosts },
          ],
          tools: [],
        };
      }
      const target = jsonRpcInterface(card);
      const allowed =
        target !== undefined &&
        URL.canParse(target.url) &&
        connection.allow.some((a) => {
          const url = new URL(target.url);
          return (
            a.host.toLowerCase() === url.hostname.replace(/^\[|\]$/g, '').toLowerCase() &&
            (a.port ?? 443) === (url.port ? Number(url.port) : 443)
          );
        });
      const skills = card.skills ?? [];
      const lacking = skills.filter((k) => !k.name || !k.description).map((k) => k.id);
      const tools = pinnedFromCard(connection.id, card);
      const results: ContractTestResult[] = [
        { name: names.setup, passed: true },
        { name: names.card, passed: true },
        lacking.length === 0
          ? {
              name: names.skills,
              passed: skills.length > 0,
              ...(skills.length === 0 ? { reason: t('blocks.noSkills') } : {}),
            }
          : {
              name: names.skills,
              passed: false,
              reason: t('blocks.skillsLacking', {
                lacking: lacking.length,
                total: skills.length,
                names: lacking.join(', '),
              }),
            },
        { name: names.timeout, passed: true },
        allowed
          ? { name: names.hosts, passed: true }
          : {
              name: names.hosts,
              passed: false,
              reason: t('blocks.otherHost', { url: target?.url ?? t('blocks.unknownAddress') }),
            },
      ];
      const provider = (card as { provider?: { organization?: unknown } }).provider?.organization;
      return {
        type: input.type,
        passed: results.every((r) => r.passed),
        results,
        tools: tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
        })),
        agent: {
          name: card.name,
          description: card.description,
          ...(card.version ? { version: card.version } : {}),
          ...(typeof provider === 'string' ? { provider } : {}),
          skills: skills.map((k) => ({
            name: k.name ?? k.id,
            ...(k.description ? { description: k.description } : {}),
          })),
        },
      };
    };

    const openApiContractTest = async (
      input: RegistrationInput,
      connection: Connection,
      signal?: AbortSignal,
    ): Promise<ContractTestReport> => {
      const names = {
        setup: t('blocks.testSetup'),
        document: t('blocks.testDocument'),
        operations: t('blocks.testOperations'),
        writes: t('blocks.testWrites'),
        hosts: t('blocks.testHosts'),
      };
      let operations: Operation[];
      try {
        operations = operationsOf(
          await loadDocument(connection, guard as EgressGuard, secrets, signal),
        );
      } catch (error) {
        const notRun = t('blocks.documentNotRead');
        const failure = egressFailure(error, notRun);
        return {
          type: input.type,
          passed: false,
          results: [
            { name: names.setup, passed: true },
            { name: names.document, passed: false, reason: failure.message },
            { name: names.operations, passed: false, reason: notRun },
            { name: names.writes, passed: true },
            connection.documentUrl
              ? { name: names.hosts, ...failure.hosts }
              : { name: names.hosts, passed: true },
          ],
          tools: [],
        };
      }
      const unknown = (connection.operations ?? []).filter(
        (id) => !operations.some((o) => o.id === id),
      );
      const enabled = operations.filter((o) => operationStatus(connection, o) === 'enabled');
      const undescribed = enabled.filter((o) => !o.summary).map((o) => o.id);
      const results: ContractTestResult[] = [
        { name: names.setup, passed: true },
        { name: names.document, passed: true },
        unknown.length > 0
          ? {
              name: names.operations,
              passed: false,
              reason: t('blocks.operationsMissing', { names: unknown.join(', ') }),
            }
          : enabled.length === 0
            ? {
                name: names.operations,
                passed: false,
                reason: t('blocks.noOperations'),
              }
            : undescribed.length > 0
              ? {
                  name: names.operations,
                  passed: false,
                  reason: t('blocks.operationsUndescribed', {
                    lacking: undescribed.length,
                    total: enabled.length,
                    names: undescribed.join(', '),
                  }),
                }
              : { name: names.operations, passed: true },
        {
          name: names.writes,
          passed: connection.writes === true || enabled.every((o) => o.readOnly),
        },
        { name: names.hosts, passed: true },
      ];
      return {
        type: input.type,
        passed: results.every((r) => r.passed),
        results,
        tools: operations.map((o) => ({
          name: `${connection.id}.${toolSlug(o.id)}`,
          ...(o.summary ? { description: o.summary } : {}),
          operation: o.id,
          method: o.method.toUpperCase(),
          path: o.path,
          readOnly: o.readOnly,
          status: operationStatus(connection, o),
        })),
      };
    };

    const contractTest = async (
      tenant: string,
      input: RegistrationInput,
      signal?: AbortSignal,
    ): Promise<ContractTestReport> => {
      const names = {
        setup: t('blocks.testSetup'),
        list: t('blocks.testList'),
        schemas: t('blocks.testSchemas'),
        timeout: t('blocks.testTimeout'),
        hosts: t('blocks.testHosts'),
      };
      const report = (results: ContractTestResult[], tools: RemoteTool[] = []) => ({
        type: input.type,
        passed: results.every((r) => r.passed),
        results,
        tools: tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
        })),
      });
      let connection: Connection;
      try {
        connection = connectionFor(tenant, input);
      } catch (error) {
        return report([{ name: names.setup, passed: false, reason: (error as Error).message }]);
      }
      const unbound = await secretProblem(connection);
      if (unbound) return report([{ name: names.setup, passed: false, reason: unbound }]);
      if (input.type === 'a2a') return a2aContractTest(input, connection, signal);
      if (input.type === 'openapi') return openApiContractTest(input, connection, signal);
      const client = new McpClient(connection, guard as EgressGuard, secrets);
      try {
        const tools = await client.listTools(signal);
        const lacking = tools.filter((t) => !t.description || !t.inputSchema).map((t) => t.name);
        return report(
          [
            { name: names.setup, passed: true },
            { name: names.list, passed: true },
            lacking.length === 0
              ? {
                  name: names.schemas,
                  passed: tools.length > 0,
                  ...(tools.length === 0 ? { reason: t('blocks.noTools') } : {}),
                }
              : {
                  name: names.schemas,
                  passed: false,
                  reason: t('blocks.toolsLacking', {
                    lacking: lacking.length,
                    total: tools.length,
                    names: lacking.join(', '),
                  }),
                },
            { name: names.timeout, passed: true },
            { name: names.hosts, passed: true },
          ],
          tools,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof EgressError ? error.code : undefined;
        const notRun = t('blocks.listNotAnswered');
        return report([
          { name: names.setup, passed: true },
          { name: names.list, passed: false, reason: message },
          { name: names.schemas, passed: false, reason: notRun },
          code === 'timeout'
            ? { name: names.timeout, passed: false, reason: message }
            : {
                name: names.timeout,
                passed: code !== undefined && code !== 'cancelled',
                ...(code ? {} : { reason: notRun }),
              },
          code === 'not_allowed' || code === 'redirect_refused' || code === 'private_address'
            ? { name: names.hosts, passed: false, reason: message }
            : {
                name: names.hosts,
                passed: code !== undefined,
                ...(code ? {} : { reason: notRun }),
              },
        ]);
      }
    };

    const manifestFor = (tenant: string, input: RegistrationInput): ManifestPreview => {
      const host = hostOf(input.endpoint);
      const secret = input.auth?.secret ? tenantSecretRef(tenant, input.auth.secret) : undefined;
      const pointKey = input.extensionPoint
        ? extensionPointLabels[input.extensionPoint]
        : undefined;
      const data =
        input.type === 'skill_package'
          ? t('blocks.dataSkillPackage')
          : input.type === 'extension_point' && pointKey
            ? t('blocks.dataExtensionPoint', { point: translate(pointKey).toLowerCase() })
            : t('blocks.dataCall');
      const permissions: BlockPermission[] = [
        { type: 'network', value: host ?? t('blocks.none'), note: '' },
        {
          type: 'secret',
          value:
            secret ?? (input.auth?.kind === 'maskinporten' ? 'Maskinporten' : t('blocks.none')),
          note: '',
        },
        { type: 'data', value: data, note: '' },
      ];
      const manifest = toYaml({
        apiVersion: 'genai/v1',
        kind: 'BuildingBlock',
        metadata: {
          tenant,
          id: input.id ?? slugOf(input.name || ''),
          name: input.name,
          version: 1,
        },
        spec: {
          type: input.type,
          ...(input.endpoint ? { endpoint: input.endpoint } : {}),
          ...(input.extensionPoint ? { extensionPoint: input.extensionPoint } : {}),
          ...(input.type === 'openapi'
            ? {
                document: input.documentUrl ?? (input.document ? 'opplastet fil' : ''),
                ...(input.operations ? { operations: input.operations } : {}),
                writes: input.writes === true,
              }
            : {}),
          auth: { kind: input.auth?.kind ?? 'none', ...(secret ? { secret } : {}) },
          permissions: {
            network: host ? [host] : [],
            secrets: secret ? [secret] : [],
            data: [data],
          },
        },
      });
      return { manifest, permissions };
    };

    const secretNames = async (tenant: string) =>
      options.secretNames ? options.secretNames(tenant) : [];

    const secretHosts = async (ref: string) => [
      ...((await options.secrets?.hostsFor?.(ref)) ?? []),
    ];

    return {
      id: 'building-blocks',
      handlers,
      decorateCapability,
      checkPublish,
      mount: <E extends Env, S extends Schema, B extends string>(
        app: Hono<E, S, B>,
        mount: MountDeps,
      ) =>
        mountRoutes(app, mount, {
          list,
          find,
          versions,
          requests,
          contractTest,
          manifestFor,
          secretNames,
          secretHosts,
          connectionFor,
          secretProblem: async (tenant, input) => {
            try {
              return await secretProblem(connectionFor(tenant, input));
            } catch {
              return undefined;
            }
          },
        }),
    };
  };

interface Reads {
  list(
    tenant: string,
    filter: {
      kind?: string | undefined;
      status?: string | undefined;
      publisher?: string | undefined;
    },
  ): Promise<BuildingBlockList>;
  find(tenant: string, kind: string, id: string): Promise<{ block: BuildingBlock } | undefined>;
  versions(tenant: string, kind: string, id: string): Promise<BlockVersion[] | undefined>;
  requests(scope?: string): Promise<ApprovalRequest[]>;
  contractTest(
    tenant: string,
    input: RegistrationInput,
    signal?: AbortSignal,
  ): Promise<ContractTestReport>;
  manifestFor(tenant: string, input: RegistrationInput): ManifestPreview;
  secretNames(tenant: string): Promise<string[]>;
  secretHosts(ref: string): Promise<string[]>;
  connectionFor(tenant: string, input: RegistrationInput): Connection;
  secretProblem(tenant: string, input: RegistrationInput): Promise<string | undefined>;
}

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 501,
  title: string,
  errors: unknown[] = [],
  extra: Record<string, unknown> = {},
) =>
  c.json({ type: 'about:blank', title, status, errors, ...extra }, status, {
    'content-type': 'application/problem+json',
  });

const undecided: RegistrationType[] = ['extension_point', 'skill_package'];
const connectionTypes: RegistrationType[] = ['mcp', 'a2a', 'openapi'];

const mountRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: MountDeps,
  reads: Reads,
) => {
  const param = (c: Context, name: string) => c.req.param(name) ?? '';
  const body = async (c: Context) =>
    (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reasonOf = (c: Context) => (changeReasonOf(c) ?? '').trim();

  const member = async (c: Context, right?: Right) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return { response: problem(c, 401, 'Unauthorized') };
    const tenant = param(c, 'tenant');
    const acting = deps.access(principal, tenant, c.req.raw);
    if (!acting) return { response: problem(c, 404, 'Not found') };
    if (right) {
      const check = requireRight(acting, tenant, right);
      if (!check.ok) return { response: rightRefused(c, check.problem) };
    }
    return { principal: acting, tenant };
  };
  const operator = async (c: Context) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return { response: problem(c, 401, 'Unauthorized') };
    if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
    return { principal };
  };

  const perform = async (
    c: Context,
    principal: Principal,
    action: string,
    data: Record<string, unknown> & { tenant: string; reason: string },
  ) => performed(c, await deps.admin.perform(principal, action, data));

  const performed = (c: Context, result: Awaited<ReturnType<MountDeps['admin']['perform']>>) => {
    c.header('genai-task', result.task);
    if (result.ok) return c.json(result.value as object, 200);
    const paths = new Set(result.errors.map((e) => e.path));
    if (paths.has('principal')) return problem(c, 403, 'Forbidden', result.errors);
    if (paths.has('block') || paths.has('request'))
      return problem(c, 404, 'Not found', result.errors);
    if (paths.has('status') || paths.has('if-match'))
      return problem(c, 409, 'Conflict', result.errors);
    return problem(c, 400, 'Invalid request', result.errors);
  };

  const needsReason = (c: Context, reason: string) =>
    isReasonLongEnough(reason)
      ? undefined
      : problem(c, 400, 'Invalid request', [{ path: 'change-reason', message: reasonTooShort }]);

  const blockRight = (kind: string): Right => rightFor(kind as BlockKind);

  const base = '/tenants/:tenant/building-blocks';

  app.get(base, async (c) => {
    const guard = await member(c);
    if (guard.response) return guard.response;
    return c.json(
      await reads.list(guard.tenant, {
        ...(c.req.query('kind') ? { kind: c.req.query('kind') } : {}),
        ...(c.req.query('status') ? { status: c.req.query('status') } : {}),
        ...(c.req.query('publisher') ? { publisher: c.req.query('publisher') } : {}),
      }),
    );
  });

  app.get(`${base}/secrets`, async (c) => {
    const guard = await member(c, 'register-building-blocks');
    if (guard.response) return guard.response;
    const prefix = tenantSecretPrefix(guard.tenant);
    const names = new Set(await reads.secretNames(guard.tenant));
    for (const state of await deps.connections.list(guard.tenant)) {
      const ref = state.connection.auth?.secret;
      if (ref?.startsWith(prefix)) names.add(ref.slice(prefix.length));
    }
    const data: TenantSecretName[] = await Promise.all(
      [...names]
        .filter((n) => /^[a-z0-9][a-z0-9._-]*$/.test(n))
        .sort()
        .map(async (name) => ({
          name,
          ref: `${prefix}${name}`,
          allowedHosts: await reads.secretHosts(`${prefix}${name}`),
        })),
    );
    return c.json({ data });
  });

  const registrationInput = (raw: Record<string, unknown>): RegistrationInput | string => {
    const type = raw.type as RegistrationType;
    if (!registrationTypes.includes(type)) return 'type';
    const auth = (raw.auth ?? undefined) as RegistrationAuth | undefined;
    return {
      type,
      name: typeof raw.name === 'string' ? raw.name.trim() : '',
      ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : {}),
      ...(typeof raw.endpoint === 'string' ? { endpoint: raw.endpoint.trim() } : {}),
      ...(auth && typeof auth === 'object' ? { auth } : {}),
      ...(typeof raw.extensionPoint === 'string' ? { extensionPoint: raw.extensionPoint } : {}),
      ...(typeof raw.document === 'string' && raw.document ? { document: raw.document } : {}),
      ...(typeof raw.documentUrl === 'string' && raw.documentUrl.trim()
        ? { documentUrl: raw.documentUrl.trim() }
        : {}),
      ...(Array.isArray(raw.operations)
        ? { operations: raw.operations.filter((o): o is string => typeof o === 'string') }
        : {}),
      ...(typeof raw.writes === 'boolean' ? { writes: raw.writes } : {}),
    };
  };

  const unsupported = (c: Context, type: RegistrationType) =>
    problem(
      c,
      501,
      undecided.includes(type) ? 'API ikke bestemt' : 'Typen støttes ikke ennå',
      [{ path: 'type', message: 'unsupported' }],
      { code: 'unsupported' },
    );

  const registration = async (c: Context, raw: Record<string, unknown>) => {
    const input = registrationInput(raw);
    if (typeof input === 'string')
      return {
        response: problem(c, 400, 'Invalid request', [
          { path: 'type', message: `must be one of ${registrationTypes.join(', ')}` },
        ]),
      };
    return { input };
  };

  app.get(`${base}/manifest-preview`, async (c) => {
    const guard = await member(c, 'register-building-blocks');
    if (guard.response) return guard.response;
    const query = c.req.query();
    const parsed = await registration(c, {
      type: query.type ?? 'mcp',
      name: query.name ?? '',
      ...(query.id ? { id: query.id } : {}),
      ...(query.endpoint ? { endpoint: query.endpoint } : {}),
      ...(query.auth
        ? { auth: { kind: query.auth, ...(query.secret ? { secret: query.secret } : {}) } }
        : {}),
      ...(query.extensionPoint ? { extensionPoint: query.extensionPoint } : {}),
    });
    if (parsed.response) return parsed.response;
    return c.json(reads.manifestFor(guard.tenant, parsed.input));
  });

  app.post(`${base}/manifest-preview`, async (c) => {
    const guard = await member(c, 'register-building-blocks');
    if (guard.response) return guard.response;
    const parsed = await registration(c, await body(c));
    if (parsed.response) return parsed.response;
    return c.json(reads.manifestFor(guard.tenant, parsed.input));
  });

  app.post(`${base}/contract-tests`, async (c) => {
    const guard = await member(c, 'register-building-blocks');
    if (guard.response) return guard.response;
    const parsed = await registration(c, await body(c));
    if (parsed.response) return parsed.response;
    if (!connectionTypes.includes(parsed.input.type)) return unsupported(c, parsed.input.type);
    return c.json(await reads.contractTest(guard.tenant, parsed.input, c.req.raw.signal));
  });

  app.post(base, async (c) => {
    const guard = await member(c, 'register-building-blocks');
    if (guard.response) return guard.response;
    const raw = await body(c);
    const parsed = await registration(c, raw);
    if (parsed.response) return parsed.response;
    const { input } = parsed;
    if (!connectionTypes.includes(input.type)) return unsupported(c, input.type);
    const reason = reasonOf(c);
    const missing = needsReason(c, reason);
    if (missing) return missing;
    const unbound = await reads.secretProblem(guard.tenant, input);
    if (unbound)
      return problem(c, 400, 'Invalid request', [{ path: 'auth.secret', message: unbound }]);
    const report = await reads.contractTest(guard.tenant, input, c.req.raw.signal);
    if (!report.passed)
      return problem(
        c,
        422,
        'Kontrakttesten er ikke bestått',
        report.results
          .filter((r) => !r.passed)
          .map((r) => ({ path: r.name, message: r.reason ?? '' })),
        { contractTests: report.results },
      );
    const wantsWrites = input.type === 'openapi' && input.writes === true;
    const connection = {
      ...reads.connectionFor(guard.tenant, input),
      ...(wantsWrites ? { writes: false } : {}),
    };
    const id = connection.id;
    const registered = await deps.admin.perform(guard.principal, 'platform.tools.register', {
      tenant: guard.tenant,
      reason,
      connection,
    });
    c.header('genai-task', registered.task);
    if (!registered.ok) {
      const forbidden = registered.errors.some((e) => e.path === 'principal');
      return problem(
        c,
        forbidden ? 403 : 400,
        forbidden ? 'Forbidden' : 'Invalid request',
        registered.errors,
      );
    }
    const synced = await deps.admin.perform(guard.principal, 'platform.tools.sync', {
      tenant: guard.tenant,
      reason,
      id,
    });
    const value = registered.value as { id: string; version: string };
    const writesRequest = wantsWrites
      ? await deps.admin.perform(guard.principal, 'platform.block.request', {
          tenant: guard.tenant,
          reason,
          op: 'writes',
          kind: 'tool',
          id,
          ...(actorNameOf(c) ? { requestedByName: actorNameOf(c) } : {}),
        })
      : undefined;
    const writesApproval =
      writesRequest?.ok === true ? (writesRequest.value as ApprovalRequest) : undefined;
    const result: RegistrationResult = {
      id: value.id,
      kind: 'tool',
      version: value.version,
      contractTests: report.results,
      synced: synced.ok,
      ...(synced.ok ? {} : { syncError: synced.errors.map((e) => e.message).join('; ') }),
      changedBy: {
        by: actorOf(guard.principal.actor ?? guard.principal),
        at: new Date().toISOString(),
        reason,
      },
      ...(writesApproval
        ? { writesApproval: { request: writesApproval.id, state: writesApproval.state } }
        : {}),
    };
    return c.json(result, 201);
  });

  app.delete(`${base}/approval-requests/:request`, async (c) => {
    const guard = await member(c, 'manage-services');
    if (guard.response) return guard.response;
    const reason = reasonOf(c);
    const rid = param(c, 'request');
    const found = (await reads.requests(guard.tenant)).find((r) => r.id === rid);
    if (!found) return problem(c, 404, 'Not found');
    const right = blockRight(found.kind);
    if (right !== 'manage-services') {
      const check = requireRight(guard.principal, guard.tenant, right);
      if (!check.ok) return rightRefused(c, check.problem);
    }
    return perform(c, guard.principal, 'platform.block.request', {
      tenant: guard.tenant,
      reason,
      op: 'withdraw',
      request: rid,
    });
  });

  app.get(`${base}/:kind/:id`, async (c) => {
    const guard = await member(c);
    if (guard.response) return guard.response;
    const found = await reads.find(guard.tenant, param(c, 'kind'), param(c, 'id'));
    return found ? c.json(found.block) : problem(c, 404, 'Not found');
  });

  app.get(`${base}/:kind/:id/versions`, async (c) => {
    const guard = await member(c);
    if (guard.response) return guard.response;
    const data = await reads.versions(guard.tenant, param(c, 'kind'), param(c, 'id'));
    return data ? c.json({ data }) : problem(c, 404, 'Not found');
  });

  app.post(`${base}/:kind/:id/adopt`, async (c) => {
    const kind = param(c, 'kind');
    const guard = await member(c, blockRight(kind));
    if (guard.response) return guard.response;
    const reason = reasonOf(c);
    const missing = needsReason(c, reason);
    if (missing) return missing;
    return perform(c, guard.principal, 'platform.block.adopt', {
      tenant: guard.tenant,
      reason,
      kind,
      id: param(c, 'id'),
    });
  });

  app.post(`${base}/:kind/:id/approval-requests`, async (c) => {
    const kind = param(c, 'kind');
    const guard = await member(c, blockRight(kind));
    if (guard.response) return guard.response;
    const reason = reasonOf(c);
    const missing = needsReason(c, reason);
    if (missing) return missing;
    return perform(c, guard.principal, 'platform.block.request', {
      tenant: guard.tenant,
      reason,
      op: 'create',
      kind,
      id: param(c, 'id'),
      ...(actorNameOf(c) ? { requestedByName: actorNameOf(c) } : {}),
    });
  });

  app.put(`${base}/:kind/:id/settings`, async (c) => {
    const kind = param(c, 'kind');
    const guard = await member(c, blockRight(kind));
    if (guard.response) return guard.response;
    const raw = await body(c);
    const reason = reasonOf(c);
    const missing = needsReason(c, reason);
    if (missing) return missing;
    const header = c.req.header('if-match')?.replace(/"/g, '');
    const ifVersion =
      header && /^\d+$/.test(header)
        ? Number(header)
        : typeof raw.ifVersion === 'number'
          ? raw.ifVersion
          : undefined;
    return perform(c, guard.principal, 'platform.block.settings', {
      tenant: guard.tenant,
      reason,
      kind,
      id: param(c, 'id'),
      settings: raw.settings,
      ...(ifVersion === undefined ? {} : { ifVersion }),
    });
  });

  app.get('/operator/building-blocks/approval-requests', async (c) => {
    const who = await operator(c);
    if (who.response) return who.response;
    const status = c.req.query('status') ?? c.req.query('state');
    const names = await deps.admin.tenantNames();
    const requests = (await reads.requests())
      .filter((r) => !status || r.state === status)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    const data = await Promise.all(
      requests.map(async (r) => {
        const found = (await reads.find(r.tenant, r.kind, r.block))?.block;
        return {
          id: r.id,
          tenant: r.tenant,
          tenantName: names.get(r.tenant) ?? r.tenant,
          block: {
            kind: r.kind,
            id: r.block,
            version: found?.version ?? null,
            name: r.blockName,
            ...(found
              ? {
                  publisher: found.publisher.name,
                  dataLocation: found.dataLocation,
                  ...(found.policyBlock ? { rule: found.policyBlock } : {}),
                  access: found.permissions,
                  scores: found.scores,
                  services: found.usedBy.map((u) => u.name),
                }
              : {}),
          },
          reason: r.reason,
          requestedBy: r.requestedByName ?? r.requestedBy,
          requestedAt: r.requestedAt,
          status: r.state,
          ...(r.grants ? { grants: r.grants } : {}),
          ...(r.decision ? { decision: r.decision } : {}),
        };
      }),
    );
    return c.json({ data });
  });

  app.post('/operator/building-blocks/approval-requests/:request/decision', async (c) => {
    const who = await operator(c);
    if (who.response) return who.response;
    const raw = await body(c);
    const reason = reasonOf(c);
    const missing = needsReason(c, reason);
    if (missing) return missing;
    const decision =
      typeof raw.approve === 'boolean' ? (raw.approve ? 'approved' : 'rejected') : raw.decision;
    const grantsWrites = (request: ApprovalRequest) =>
      request.grants === 'writes' && request.state === 'approved';
    const decided = await deps.admin.performThen<ApprovalRequest>(
      { ...who.principal, tenant: deps.platformTenant },
      'platform.block.decide',
      {
        tenant: deps.platformTenant,
        reason,
        request: param(c, 'request'),
        decision,
        byName: actorNameOf(c),
      },
      async (request) => {
        if (!grantsWrites(request)) return;
        const state = await deps.connections.get(request.tenant, request.block);
        if (state)
          await deps.connections.save({
            ...state,
            connection: { ...state.connection, writes: true },
          });
      },
    );
    const request = decided.ok ? decided.value : undefined;
    if (request && grantsWrites(request)) {
      const state = await deps.connections.get(request.tenant, request.block);
      if (state) {
        const actor = { ...who.principal, tenant: request.tenant, actor: who.principal };
        await deps.admin.perform(actor, 'platform.tools.sync', {
          tenant: request.tenant,
          reason,
          id: request.block,
        });
        const synced = await deps.connections.get(request.tenant, request.block);
        for (const tool of synced?.pending ?? []) {
          const method = tool.call?.method;
          if (typeof method !== 'string' || method.toLowerCase() === 'get') continue;
          await deps.admin.perform(actor, 'platform.tools.approve', {
            tenant: request.tenant,
            reason,
            id: request.block,
            tool: tool.name,
          });
        }
      }
    }
    return performed(c, decided);
  });
};

export const buildingBlocksModule: PlatformModuleFactory = createBuildingBlocksModule();
