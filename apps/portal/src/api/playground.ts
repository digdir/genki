import type { ApiContext } from '../api';
import type { Problem, Residency, TimelineStep } from '../types';
import { ApiError } from './error';

export type PlaygroundOutput = 'text' | 'fields';
export type PlaygroundModelStatus = 'allowed' | 'requires_approval' | 'not_allowed';

export interface PlaygroundServiceRef {
  id: string;
  version: number | 'draft';
  definition?: unknown;
  files?: Record<string, string>;
}

export interface PlaygroundSetup {
  service?: PlaygroundServiceRef;
  model: string;
  datasets: string[];
  skills: string[];
  blocks: string[];
  output: PlaygroundOutput;
}

export interface PlaygroundServiceVersion {
  version: number;
  draft: boolean;
  inUse: boolean;
  setup: Omit<PlaygroundSetup, 'service'>;
  inputFields?: PlaygroundInputField[];
}

export interface PlaygroundServiceOption {
  id: string;
  name: string;
  chat?: boolean;
  exampleQuestions?: string[];
  versions: PlaygroundServiceVersion[];
  latestVersion: number;
}

export interface PlaygroundPolicy {
  block: string;
  rule: string;
  ownedBy: string;
  link: string;
}

export interface PlaygroundModelOption {
  id: string;
  name: string;
  dataLocation: Residency;
  status: PlaygroundModelStatus;
  policy?: PlaygroundPolicy;
}

export interface PlaygroundNamed {
  id: string;
  name: string;
}

export interface PlaygroundDatasetOption extends PlaygroundNamed {
  dataLocation?: Residency;
  status?: PlaygroundModelStatus;
}

export interface PlaygroundSkillOption extends PlaygroundNamed {
  version?: number;
  ref?: string;
}

export interface PlaygroundBlockOption extends PlaygroundNamed {
  kind?: string;
  status?: PlaygroundModelStatus;
}

export interface PlaygroundTestSet extends PlaygroundNamed {
  cases: number;
  service?: string;
  skill?: string;
}

export interface PlaygroundQuota {
  usedPercent: number;
  monthlyTokens: number;
}

export interface PlaygroundOptions {
  services: PlaygroundServiceOption[];
  models: PlaygroundModelOption[];
  datasets: PlaygroundDatasetOption[];
  skills: PlaygroundSkillOption[];
  blocks: PlaygroundBlockOption[];
  testSets: PlaygroundTestSet[];
  defaultBlocks?: string[];
  outputs?: PlaygroundOutput[];
  quota: PlaygroundQuota;
}

export type PlaygroundFile =
  string | { name: string; mediaType?: string; data: string } | { name?: string; sample: true };

export type PlaygroundInput =
  | { text: string }
  | { file: PlaygroundFile }
  | { fields: Record<string, string | number | string[]>; text?: string };

export interface PlaygroundInputField {
  id: string;
  label: string;
  kind:
    'text' | 'long-text' | 'choice' | 'multi-choice' | 'number' | 'year' | 'date' | 'organisation';
  required?: boolean;
  help?: string;
  options?: string[];
  optionsFrom?: { dataset: string; facet: string };
}

export interface PlaygroundHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface PlaygroundRunRequest {
  setup: PlaygroundSetup;
  compareWith?: PlaygroundSetup;
  input: PlaygroundInput;
  history?: PlaygroundHistoryTurn[];
  answerLanguage?: 'nb' | 'nn' | 'en';
}

export interface PlaygroundSource {
  chunkId: string;
  title?: string;
  url?: string;
  text?: string;
  headers?: string[];
  document?: string;
  position?: number;
  excerpt?: string;
  version?: string | number;
  publishedAt?: string;
  score?: number;
}

export interface PlaygroundSearchNote {
  document: string;
  reason: string;
}

export interface PlaygroundResult {
  runId: string;
  text?: string;
  noAnswer?: boolean;
  fields?: Record<string, unknown>;
  table?: unknown;
  csv?: string;
  sources: PlaygroundSource[];
  searchNotes: PlaygroundSearchNote[];
  timeMs: number;
  tokensIn: number;
  tokensOut: number;
  costNok: number | null;
  dataLocation: Residency | null;
  citations?: PlaygroundCitation[];
  byModel?: PlaygroundModelUsage[];
  clarification?: PlaygroundClarification;
  steps?: TimelineStep[];
  stats?: RunStats;
}

export interface PlaygroundCitation {
  index: number;
  chunkId: string;
}

export interface PlaygroundModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costNok: number | null;
}

export interface PlaygroundClarification {
  question: string;
  options: string[];
}

export interface RunStats {
  iterations: number;
  toolCalls: number;
  chunksRead: number;
  documents: number;
  warnings: string[];
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  byModel: { model: string; inputTokens: number; outputTokens: number; calls: number }[];
}

export type PlaygroundRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type PlaygroundSetupName = 'setup' | 'compareWith';

export interface PlaygroundStreamProblem {
  type?: string;
  status: number;
  title: string;
  code?: string;
  step?: string;
  detail?: string;
  runId?: string;
  errors?: { path: string; message: string }[];
}

export type PlaygroundStreamEvent =
  | { event: 'started'; setup: PlaygroundSetupName; runId: string; startedAt: string }
  | { event: 'status'; setup: PlaygroundSetupName; status: PlaygroundRunStatus }
  | { event: 'step'; setup: PlaygroundSetupName; step: TimelineStep }
  | { event: 'remove'; setup: PlaygroundSetupName; id: string }
  | { event: 'delta'; setup: PlaygroundSetupName; text: string; channel: 'answer' | 'reasoning' }
  | { event: 'retract'; setup: PlaygroundSetupName; reason: string }
  | { event: 'stats'; setup: PlaygroundSetupName; stats: RunStats }
  | { event: 'result'; setup: PlaygroundSetupName; result: PlaygroundResult }
  | { event: 'failed'; setup: PlaygroundSetupName; problem: PlaygroundStreamProblem }
  | { event: 'done'; quota: PlaygroundQuota };

export interface PlaygroundRunResponse extends PlaygroundResult {
  compare?: PlaygroundResult;
  quota: PlaygroundQuota;
}

export interface PlaygroundRefusal {
  type: string;
  title: string;
  status: 403;
  setup: 'setup' | 'compareWith';
  policy: PlaygroundPolicy;
}

export interface TestCaseCandidateRequest {
  task: string;
  question: string;
  answer: string;
  testSet: string;
  service?: string;
  origin: 'playground';
}

export interface TestCaseCandidate {
  id: string;
  task: string;
  question: string;
  answer?: string;
  status: string;
  service?: string;
  targetTestSet?: string;
  origin?: 'playground';
}

const streamEvents = new Set([
  'started',
  'status',
  'step',
  'remove',
  'delta',
  'retract',
  'stats',
  'result',
  'failed',
  'done',
]);

export const parseSseMessage = (block: string): PlaygroundStreamEvent | undefined => {
  let name = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!streamEvents.has(name) || data.length === 0) return undefined;
  try {
    return { ...(JSON.parse(data.join('\n')) as object), event: name } as PlaygroundStreamEvent;
  } catch {
    return undefined;
  }
};

export const readSse = async (
  response: Response,
  onEvent: (event: PlaygroundStreamEvent) => void,
  signal?: AbortSignal,
) => {
  const emit = (block: string) => {
    const parsed = parseSseMessage(block);
    if (parsed) onEvent(parsed);
  };
  if (!response.body) {
    for (const block of (await response.text()).split(/\r?\n\r?\n/)) emit(block);
    return;
  }
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', abort);
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) emit(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) emit(buffer);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
};

export const playgroundApi = (ctx: ApiContext) => ({
  options: (tenant: string, signal?: AbortSignal) =>
    ctx.get<PlaygroundOptions>(`${ctx.tenantPath(tenant)}/playground/options`, signal),
  run: (tenant: string, body: PlaygroundRunRequest) =>
    ctx.request<PlaygroundRunResponse>('POST', `${ctx.tenantPath(tenant)}/playground/runs`, body),
  runStream: async (
    tenant: string,
    body: PlaygroundRunRequest,
    onEvent: (event: PlaygroundStreamEvent) => void,
    signal?: AbortSignal,
  ) => {
    if (!ctx.send) {
      const { compare, quota, ...result } = await ctx.request<PlaygroundRunResponse>(
        'POST',
        `${ctx.tenantPath(tenant)}/playground/runs`,
        body,
      );
      onEvent({ event: 'result', setup: 'setup', result });
      if (compare) onEvent({ event: 'result', setup: 'compareWith', result: compare });
      onEvent({ event: 'done', quota });
      return;
    }
    const response = await ctx.send(
      'POST',
      `${ctx.tenantPath(tenant)}/playground/runs/stream`,
      body,
      { accept: 'text/event-stream' },
    );
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as Problem | undefined;
      throw new ApiError(response.status, problem);
    }
    await readSse(response, onEvent, signal);
  },
  proposeTestCase: (tenant: string, body: TestCaseCandidateRequest) =>
    ctx.request<TestCaseCandidate>('POST', `${ctx.tenantPath(tenant)}/testcase-candidates`, body),
});

export type PlaygroundApi = ReturnType<typeof playgroundApi>;
