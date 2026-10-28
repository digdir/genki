export type JsonPatchOp =
  | { op: 'add' | 'replace' | 'test'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'move' | 'copy'; from: string; path: string };

export type TurnStatus = 'completed' | 'refused' | 'unavailable' | 'budget_exhausted';
export const unavailableReasons = [
  'not_published',
  'no_model',
  'model_failed',
  'empty_result',
] as const;
export type UnavailableReason = (typeof unavailableReasons)[number];

export const serviceIntents = ['chat', 'improve-instructions', 'suggest-test-cases'] as const;
export const skillIntents = [
  'suggest-description',
  'suggest-instructions',
  'suggest-examples',
  'fix-instructions',
] as const;
export const stepFlowIntents = ['chat'] as const;
export type ServiceIntent = (typeof serviceIntents)[number];
export type SkillIntent = (typeof skillIntents)[number];
export type BuilderIntent = ServiceIntent | SkillIntent;
export type BuilderTarget = 'service' | 'skill' | 'stepflow';

export interface AssistantQuestion {
  id: string;
  label: string;
  options: string[];
  allowOther: boolean;
}

export interface RejectedChange {
  attempted: string;
  reason: string;
  code: string;
}

export type PolicyCode = 'secrets' | 'risk' | 'risk-class' | 'identity' | 'block' | 'residency';

export interface PolicyRefusal {
  code?: PolicyCode;
  rule: string;
  ownedBy: string;
  link?: string;
  alternative?: string;
}

export interface ConnectorMapping {
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
  engine: 'postgres';
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
  filter: ConnectorCondition[];
}

export interface ProposalPermission {
  type: string;
  value: string;
  note?: string;
}

export interface ProposalTest {
  name: string;
  passed: boolean;
  reason?: string;
}

export type PlatformChangeStatus = 'sent' | 'under_review' | 'planned' | 'rejected';

export interface PlatformChange {
  summary: string;
  caseId: string;
  status: PlatformChangeStatus;
}

export type ProposalLevel = 1 | 2 | 3 | 4;
export type ProposalKind = 'change' | 'connector' | 'building_block' | 'platform_change';

export interface AssistantProposal {
  id: string;
  level: ProposalLevel;
  kind: ProposalKind;
  title: string;
  detail: string;
  section?: string;
  patch?: JsonPatchOp[];
  after?: Record<string, unknown>;
  validation: { ok: boolean; errors?: { path: string; message: string }[] };
  requiresApproval: boolean;
  appliedToDraft: false;
  storedProposalId?: string;
  mapping?: ConnectorMapping[];
  source?: ConnectorSource;
  permissions?: ProposalPermission[];
  tests?: ProposalTest[];
  quality?: string;
  platformChange?: PlatformChange;
  approval?: { right: string };
  flows?: Record<string, unknown>[];
}

export interface ImprovedInstructions {
  before: string;
  after: string;
  changes: string[];
}

export interface SuggestedTestCase {
  id: string;
  input: string;
  expected: string;
  source?: string;
}

export interface TurnUsage {
  tokens: number;
  budgetLeftToday: number;
  dailyBudget: number;
}

export interface AssistantTurn {
  turnId: string;
  status: TurnStatus;
  reason?: UnavailableReason;
  message: string;
  questions?: AssistantQuestion[];
  proposals: AssistantProposal[];
  rejected?: RejectedChange[];
  policy?: PolicyRefusal;
  improvedInstructions?: ImprovedInstructions;
  testCases?: SuggestedTestCase[];
  usage: TurnUsage;
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}

export type BuilderTurnResult = Omit<AssistantTurn, 'turnId' | 'usage'> & {
  transcript?: ConversationEntry[];
};

export type Residency = 'norway' | 'eu' | 'global';

export type BlockKind = 'model' | 'dataset' | 'tool' | 'skill' | 'guardrail';

export interface AvailableBlock {
  kind: BlockKind;
  id: string;
  name: string;
  description?: string;
  dataLocation?: Residency | null;
  capabilities?: string[];
}

export interface RefusedBlock {
  kind: BlockKind;
  id: string;
  rule: string;
  ownedBy: string;
  link?: string;
}

export interface BlockedResidency {
  residency: Residency;
  rule: string;
  ownedBy: string;
  link?: string;
}

export interface RecipeInfo {
  ref: string;
  title: { nb: string; en: string };
  summary: { nb: string; en: string };
  purpose: string;
  settings: unknown;
}

export interface BuilderContext {
  available: AvailableBlock[];
  recipes?: RecipeInfo[];
  refused: RefusedBlock[];
  blockedResidencies: BlockedResidency[];
  tenantName?: string;
  rights?: string[];
}

export interface BuilderTurnInput {
  target: BuilderTarget;
  tenant: string;
  message: string;
  answers?: Record<string, string>;
  history?: ConversationEntry[];
  intent: BuilderIntent;
  draft: Record<string, unknown>;
  model: string;
  systemPrompt: string;
  stream: boolean;
  context: BuilderContext;
}

export type BuilderTurnRequest = Omit<BuilderTurnInput, 'model' | 'systemPrompt'>;

export type BuilderEvent =
  | { type: 'delta'; data: { text: string } }
  | { type: 'paragraph'; data: { text: string } }
  | { type: 'question'; data: AssistantQuestion }
  | { type: 'proposal'; data: AssistantProposal }
  | { type: 'rejected'; data: RejectedChange };
