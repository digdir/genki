import type { ApiContext } from '../api';

export type AssistantIntent = 'chat' | 'improve-instructions' | 'suggest-test-cases';
export type AssistantStatus = 'completed' | 'refused' | 'unavailable' | 'budget_exhausted';
export type AssistantUnavailableReason =
  'not_published' | 'no_model' | 'model_failed' | 'empty_result';
export type ProposalLevel = 1 | 2 | 3 | 4;
export type ProposalKind = 'change' | 'connector' | 'building_block' | 'platform_change';
export type PlatformChangeStatus = 'sent' | 'under_review' | 'planned' | 'rejected';

export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

export interface AssistantQuestion {
  id: string;
  label: string;
  options: string[];
  allowOther: boolean;
}

export interface AssistantRejected {
  attempted: string;
  reason: string;
  code: string;
}

export interface AssistantPolicy {
  rule: string;
  ownedBy: string;
  link?: string;
  alternative?: string;
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

export interface TestCaseSuggestionCandidate {
  task: string;
  question: string;
  answer: string;
  testSet: string;
  service: string;
  origin: 'assistant';
}

export interface AssistantUsage {
  tokens: number;
  budgetLeftToday: number;
  dailyBudget: number;
}

export interface ProposalMapping {
  table: string;
  becomes: 'document' | 'field' | 'attachment' | 'excluded';
  fields?: string[];
  reason?: string;
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

export interface PlatformChange {
  summary: string;
  caseId: string;
  status: PlatformChangeStatus;
  rejectionReason?: string;
}

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
  mapping?: ProposalMapping[];
  permissions?: ProposalPermission[];
  tests?: ProposalTest[];
  quality?: string;
  platformChange?: PlatformChange;
  flows?: Record<string, unknown>[];
}

export interface AssistantTurn {
  turnId: string;
  status: AssistantStatus;
  reason?: AssistantUnavailableReason;
  message: string;
  questions?: AssistantQuestion[];
  proposals: AssistantProposal[];
  rejected?: AssistantRejected[];
  policy?: AssistantPolicy;
  improvedInstructions?: ImprovedInstructions;
  testCases?: SuggestedTestCase[];
  usage: AssistantUsage;
}

export interface AssistantTurnRequest {
  message: string;
  draft: { definition: Record<string, unknown> | string };
  answers?: Record<string, string>;
  intent?: AssistantIntent;
  previousTurn?: string;
  stream?: boolean;
}

export type AssistantEvent =
  | { type: 'delta'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'question'; question: AssistantQuestion }
  | { type: 'proposal'; proposal: AssistantProposal }
  | { type: 'rejected'; rejected: AssistantRejected }
  | { type: 'done'; turn: AssistantTurn };

export type CatalogProposalState = 'pending' | 'sent_for_approval' | 'approved' | 'rejected';

export interface CatalogProposal {
  id: string;
  level: ProposalLevel;
  createdBy: 'assistant';
  forService: { id: string; name: string };
  createdAt: string;
  item?: unknown;
  mapping?: ProposalMapping[];
  permissions: ProposalPermission[];
  tests: ProposalTest[];
  quality?: string;
  state: CatalogProposalState;
  platformChange?: PlatformChange;
  decision?: { by: string; at: string; reason: string };
}

export interface ProposalDecision {
  proposal: CatalogProposal;
  changedBy: { by: string; at: string; reason: string };
}

export type RawSend = (
  method: string,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) => Promise<Response>;

export class AssistantRequestError extends Error {
  constructor(
    readonly status: number,
    title?: string,
  ) {
    super(title ?? `Request failed with status ${status}`);
    this.name = 'AssistantRequestError';
  }
}

const toEvent = (name: string, data: string): AssistantEvent | undefined => {
  const value = JSON.parse(data) as Record<string, unknown>;
  if (name === 'delta' || name === 'paragraph')
    return { type: name, text: typeof value.text === 'string' ? value.text : '' };
  if (name === 'question') return { type: 'question', question: value as never };
  if (name === 'proposal') return { type: 'proposal', proposal: value as never };
  if (name === 'rejected') return { type: 'rejected', rejected: value as never };
  if (name === 'done') return { type: 'done', turn: value.turn as AssistantTurn };
  return undefined;
};

export async function* readAssistantEvents(response: Response): AsyncGenerator<AssistantEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (block: string) => {
    let name = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? toEvent(name, data.join('\n')) : undefined;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let end = buffer.search(/\r?\n\r?\n/);
    while (end >= 0) {
      const event = parse(buffer.slice(0, end));
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, '');
      if (event) yield event;
      end = buffer.search(/\r?\n\r?\n/);
    }
    if (done) break;
  }
  const last = buffer.trim() ? parse(buffer) : undefined;
  if (last) yield last;
}

export const assistantApi = (ctx: ApiContext & { send?: RawSend }) => {
  const turnPath = (tenant: string, service: string) =>
    `${ctx.tenantPath(tenant)}/services/${encodeURIComponent(service)}/assistant/turns`;
  const proposalPath = (tenant: string, id: string, action: string) =>
    `${ctx.tenantPath(tenant)}/proposals/${encodeURIComponent(id)}/${action}`;
  const decide = (action: string) => (tenant: string, id: string, reason: string) =>
    ctx.request<ProposalDecision>(
      'POST',
      proposalPath(tenant, id, action),
      { reason },
      { 'change-reason': reason },
    );
  return {
    turnPath,
    streams: !!ctx.send,
    turn: async (
      tenant: string,
      service: string,
      body: AssistantTurnRequest,
      onEvent?: (event: AssistantEvent) => void,
    ): Promise<{ turn: AssistantTurn; streamed: boolean }> => {
      if (!onEvent || !ctx.send)
        return {
          turn: await ctx.request<AssistantTurn>('POST', turnPath(tenant, service), {
            ...body,
            stream: false,
          }),
          streamed: false,
        };
      const response = await ctx.send(
        'POST',
        turnPath(tenant, service),
        { ...body, stream: true },
        { accept: 'text/event-stream' },
      );
      if (!response.ok) {
        const problem = (await response.json().catch(() => undefined)) as
          { title?: string } | undefined;
        throw new AssistantRequestError(response.status, problem?.title);
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream'))
        return { turn: (await response.json()) as AssistantTurn, streamed: false };
      let final: AssistantTurn | undefined;
      for await (const event of readAssistantEvents(response)) {
        onEvent(event);
        if (event.type === 'done') final = event.turn;
      }
      if (!final) throw new AssistantRequestError(502, 'Svaret fra assistenten ble avbrutt.');
      return { turn: final, streamed: true };
    },
    proposeTestCase: (tenant: string, body: TestCaseSuggestionCandidate) =>
      ctx.request<{ id: string }>('POST', `${ctx.tenantPath(tenant)}/testcase-candidates`, body),
    approveProposal: decide('approve'),
    rejectProposal: decide('reject'),
    sendProposalForApproval: decide('send-for-approval'),
  };
};
