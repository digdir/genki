import type { Locale } from '@genai/i18n';
import type { ResultTable } from './ResultTable';
export interface Organisation {
  orgNumber: string;
  name: string;
  actions?: string[];
}

export interface Session {
  name: string;
  organisations: Organisation[];
  token: string;
}

export type InputKind =
  'text' | 'long-text' | 'choice' | 'multi-choice' | 'number' | 'year' | 'date' | 'organisation';

export interface InputField {
  id: string;
  label: string;
  kind: InputKind;
  required?: boolean;
  help?: string;
  options?: string[];
  dependsOn?: string;
  default?: string | number | string[];
}

export type FormInput = Record<string, string | number | string[]>;

export interface ServiceOption {
  id: string;
  name: string;
  description?: string;
  processing?: string;
  prompt?: string;
  paused?: boolean;
  pausedReason?: string;
  batch?: boolean;
  inputFields?: InputField[];
  documents?: DocumentRules;
}

export interface DocumentRules {
  accepts: string[];
  maxBytes: number;
  maxCount: number;
}

export interface AttachedDocument {
  name: string;
  mediaType: string;
  data: string;
}

export interface Source {
  title: string;
  index?: number;
  url?: string;
  excerpt?: string;
  version?: string;
  publishedAt?: string;
}

export type Lang = 'nb' | 'nn' | 'en';

export type FailureKind =
  | 'quota'
  | 'unavailable'
  | 'service-failed'
  | 'refused'
  | 'no-sources'
  | 'signed-out'
  | 'no-access'
  | 'paused'
  | 'invalid-input';

export interface ChatFailure {
  kind: FailureKind;
  message?: string;
}

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
  lang: Lang;
  values?: { label: string; value: string }[];
  input?: FormInput;
  attachments?: string[];
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  text: string;
  lang: Lang;
  sources: Source[];
  task?: string;
  failure?: ChatFailure;
  pending?: boolean;
  noAnswer?: boolean;
  table?: ResultTable;
  csv?: string;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface ChatReply {
  text: string;
  sources: Source[];
  noAnswer?: boolean;
  table?: ResultTable;
  csv?: string;
  task?: string;
  conversationId?: string;
  failure?: ChatFailure;
}

export interface ConversationSummary {
  id: string;
  title: string;
  agentId: string;
  created: string;
}

export interface ConversationApi {
  list(signal?: AbortSignal): Promise<ConversationSummary[]>;
  messages(id: string, signal?: AbortSignal): Promise<ChatMessage[]>;
  rename?(id: string, title: string): Promise<void>;
}

export type Rating = 'up' | 'down';

export interface FeedbackInput {
  task?: string;
  rating: Rating;
  reasons: string[];
  comment: string;
}

export interface WorkspaceApi {
  listServices(signal?: AbortSignal): Promise<ServiceOption[]>;
  chat(
    service: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    onDelta: (text: string) => void,
    signal?: AbortSignal,
    input?: FormInput,
    conversation?: { id?: string },
    documents?: AttachedDocument[],
  ): Promise<ChatReply>;
  conversations?: ConversationApi;
  sendFeedback(input: FeedbackInput): Promise<void>;
  failedRuns?(tenant: string, signal?: AbortSignal): Promise<FailedRun[]>;
  rights?(tenant: string, signal?: AbortSignal): Promise<string[]>;
  writtenStandard?(tenant: string, signal?: AbortSignal): Promise<WrittenStandard>;
  setWrittenStandard?(tenant: string, value: WrittenStandard): Promise<void>;
  language?(tenant: string, signal?: AbortSignal): Promise<Locale | null>;
  setLanguage?(tenant: string, value: Locale | null): Promise<void>;
  tableReview?(tenant: string, task: string, signal?: AbortSignal): Promise<TableReview>;
  saveTableEdits?(tenant: string, task: string, edits: CellEdit[]): Promise<TableReview>;
  approveTable?(tenant: string, task: string): Promise<TableReview>;
}

export type WrittenStandard = 'user' | 'bokmal' | 'nynorsk';

export interface CellEdit {
  row: number;
  column: string;
  value: string;
}

export interface TableReview {
  service?: string;
  createdAt?: string;
  input?: Record<string, unknown>;
  table?: ResultTable;
  csv?: string;
  edits: (CellEdit & { original?: unknown; byName?: string })[];
  approval: { status: 'draft' } | { status: 'approved'; by?: string; byName?: string; at: string };
}

export interface FailedRun {
  id: string;
  service: string;
  serviceName?: string;
  at: string;
  reason: string;
  step?: string;
}

export type DueColor = 'danger' | 'warning' | 'neutral';

export interface Approval {
  id: string;
  service: string;
  caseNumber: string;
  title: string;
  due: string;
  dueColor: DueColor;
  assignedTo: string;
  text: string;
  basisUrl: string;
}

export type Decision = 'approved' | 'rejected';

export interface ApprovalsApi {
  listPending(signal?: AbortSignal): Promise<Approval[]>;
  resolve(id: string, decision: Decision, comment: string): Promise<void>;
}

export interface Part {
  mime: string;
  body: { kind: 'text'; text: string } | { kind: 'json'; json: unknown };
}

export interface Provenance {
  task: string;
  service?: {
    capability: { id: string; version: string };
    strategy: { id: string; version: string };
    configHash: string;
  };
  models: string[];
  sources: string[];
  approved?: boolean;
  approver?: string;
  aiDisclosure: string;
}

export interface DocumentDraft {
  agency: string;
  caseNumber: string;
  createdAt: string;
  serviceName: string;
  sourceLabels: Record<string, string>;
  parts: Part[];
}
