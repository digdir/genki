// Pure checks for the post-deploy smoke test; run.ts does the HTTP calls.

export type Tier = 'free' | 'cheap' | 'core';
export type WantedTiers = 'free' | 'cheap' | 'all';
export type Outcome = 'pass' | 'flaky' | 'fail' | 'skip';
export type SkipReason = 'budget' | 'time' | 'tier' | 'key' | 'unavailable';

export interface Verdict {
  ok: boolean;
  detail: string;
  retry?: boolean;
  task?: string;
  tokens?: Tokens;
}

export interface Tokens {
  input: number;
  output: number;
}

export interface CheckResult {
  id: string;
  tier: Tier;
  outcome: Outcome;
  detail: string;
  attempts: number;
  tasks: string[];
  skipReason?: SkipReason;
  tokens?: Tokens;
  costKr?: number;
}

export interface SmokeReport {
  sha: string;
  api: string;
  tiers: Tier[];
  notes: string[];
  checks: CheckResult[];
  spentKr: number;
  outcome: 'pass' | 'fail' | 'partial';
  runUrl?: string;
}

export interface Price {
  input: number;
  output: number;
}

export interface Question {
  id: string;
  variant: string;
  model: string;
  question: string;
  stream: boolean;
  minCitations?: number;
  minSources?: number;
  detected?: string[];
  estimateKr: number;
}

export interface Plan {
  tenant: string;
  service: string;
  maxKrPerRun: number;
  prices: Record<string, Price>;
  models: { variant: string; model: string; estimateKr: number }[];
  modelQuestion: string;
  facets: { fields: string[]; values: string[] };
  questions: Question[];
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

const sha = /^[0-9a-f]{40}$/;

export const detectedLabels = ['Found in the search', 'Gjenkjent i søket'];

export const clip = (text: string, max = 200) => {
  const line = text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').replace(/@/g, '@​').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const tiersToRun = (
  wanted: WantedTiers,
  runsToday: number | undefined,
  maxRunsPerDay: number,
): { tiers: Tier[]; note?: string } => {
  const all: Tier[] =
    wanted === 'free'
      ? ['free']
      : wanted === 'cheap'
        ? ['free', 'cheap']
        : ['free', 'cheap', 'core'];
  if (runsToday === undefined)
    return wanted === 'free'
      ? { tiers: all }
      : { tiers: ['free'], note: 'Could not count today’s runs, so only the free tier ran.' };
  if (runsToday > maxRunsPerDay && wanted !== 'free')
    return {
      tiers: ['free'],
      note: `${runsToday} smoke runs today, over the cap of ${maxRunsPerDay}, so only the free tier ran.`,
    };
  return { tiers: all };
};

export const assessHealth = (
  result: HttpResult,
  expected: string | undefined,
): Verdict & { version?: string; lockdown?: boolean } => {
  const body = record(json(result.text));
  const version = typeof body.version === 'string' ? body.version : undefined;
  const lockdown = typeof body.lockdown === 'boolean' ? body.lockdown : undefined;
  if (result.status !== 200 || body.status !== 'ok')
    return { ok: false, detail: `/health answered ${result.status}` };
  if (!version || !sha.test(version))
    return { ok: false, detail: `/health reports no commit SHA (${clip(String(version))})` };
  if (expected && version !== expected)
    return {
      ok: false,
      detail: `/health reports ${version.slice(0, 8)}, expected ${expected.slice(0, 8)}`,
      version,
    };
  return {
    ok: true,
    detail: `${version.slice(0, 8)}${lockdown ? ', lockdown' : ''}`,
    version,
    ...(lockdown === undefined ? {} : { lockdown }),
  };
};

export const assessOpenapi = (result: HttpResult, version: string): Verdict => {
  const body = record(json(result.text));
  const info = record(body.info);
  if (result.status !== 200)
    return { ok: false, detail: `/openapi.json answered ${result.status}` };
  if (info.version !== version)
    return {
      ok: false,
      detail: `version ${clip(String(info.version))}, expected ${version.slice(0, 8)}`,
    };
  if (!('/v1/chat/completions' in record(body.paths)))
    return { ok: false, detail: 'no /v1/chat/completions route' };
  return { ok: true, detail: `${Object.keys(record(body.paths)).length} routes` };
};

export const assessPage = (result: HttpResult): Verdict =>
  result.status === 200
    ? { ok: true, detail: '200' }
    : { ok: false, detail: `answered ${result.status}` };

export interface ServiceDataset {
  tenant: string;
  key: string;
}

export const assessModels = (
  result: HttpResult,
  service: string,
  variants: string[],
): Verdict & { dataset?: ServiceDataset } => {
  if (result.status !== 200) return { ok: false, detail: `/v1/models answered ${result.status}` };
  const rows = list(record(json(result.text)).data).map(record);
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const missing = variants.filter((v) => !byId.has(`${service}__${v}`));
  if (missing.length)
    return { ok: false, detail: `missing ${missing.map((v) => `${service}__${v}`).join(', ')}` };
  const paused = variants.filter((v) => byId.get(`${service}__${v}`)?.status === 'paused');
  if (paused.length) return { ok: false, detail: `paused: ${paused.join(', ')}` };
  const first = record(list(byId.get(`${service}__${variants[0]}`)?._datasets)[0]);
  const dataset =
    typeof first.tenant === 'string' && typeof first['dataset-config-key'] === 'string'
      ? { tenant: first.tenant, key: first['dataset-config-key'] }
      : undefined;
  return { ok: true, detail: `${variants.length} variants`, ...(dataset ? { dataset } : {}) };
};

export const assessFacets = (result: HttpResult, values: string[]): Verdict => {
  if (result.status !== 200) return { ok: false, detail: `/api/facets answered ${result.status}` };
  const fields = list(record(json(result.text)).fields).map(record);
  const where = (value: string) =>
    fields
      .filter((f) => list(f.options).some((o) => record(o).value === value))
      .map((f) => String(f.field));
  const missing = values.filter((v) => where(v).length === 0);
  if (missing.length) return { ok: false, detail: `no facet value ${missing.join(', ')}` };
  return { ok: true, detail: values.map((v) => `${v} in ${where(v).join('+')}`).join('; ') };
};

const transientStatuses = new Set([429, 502, 503, 504]);

export const isTransient = (result: HttpResult) => {
  if (transientStatuses.has(result.status)) return true;
  return result.status === 500 && record(record(json(result.text)).error).model_failed === true;
};

const errorText = (result: HttpResult) => {
  const error = record(record(json(result.text)).error);
  const code = typeof error.failure_code === 'string' ? error.failure_code : error.code;
  const message = typeof error.message === 'string' ? error.message : result.text;
  return `${result.status}${code ? ` ${clip(String(code), 40)}` : ''}: ${clip(message, 160)}`;
};

export interface Expect {
  minSources?: number;
  minCitations?: number;
  model?: string;
  answer: boolean;
}

const sourceCheck = (sources: unknown[], expect: Expect): string | undefined => {
  const cited = sources.filter((s) => typeof record(s).index === 'number').length;
  if (expect.minCitations !== undefined && cited < expect.minCitations)
    return `${cited} cited sources, expected at least ${expect.minCitations}`;
  if (expect.minSources !== undefined && sources.length < expect.minSources)
    return `${sources.length} sources, expected at least ${expect.minSources}`;
  return undefined;
};

const taskOf = (result: HttpResult) => {
  const task = result.headers['genai-task'];
  return task ? clip(task, 80) : undefined;
};

export const assessCompletion = (result: HttpResult, expect: Expect): Verdict => {
  const task = taskOf(result);
  const withTask = task ? { task } : {};
  if (result.status !== 200)
    return { ok: false, detail: errorText(result), retry: isTransient(result), ...withTask };
  const body = record(json(result.text));
  const choice = record(list(body.choices)[0]);
  const content = record(choice.message).content;
  const usage = record(body.usage);
  const tokens =
    typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number'
      ? { input: usage.prompt_tokens, output: usage.completion_tokens }
      : undefined;
  const withTokens = { ...withTask, ...(tokens ? { tokens } : {}) };
  const fail = (detail: string): Verdict => ({ ok: false, detail, retry: true, ...withTokens });
  if (choice.finish_reason !== 'stop')
    return fail(`finish_reason ${clip(String(choice.finish_reason))}`);
  if (expect.answer && (typeof content !== 'string' || !content.trim()))
    return fail('empty answer');
  if (expect.answer && !tokens) return fail('no token usage');
  const model = result.headers['genai-model'];
  if (expect.model && model && model !== expect.model)
    return {
      ok: false,
      detail: `answered by ${clip(model)}, expected ${expect.model}`,
      ...withTokens,
    };
  const unproven = expect.model && !model ? ', model not named by genai-model' : '';
  const sources = sourceCheck(list(body.sources), expect);
  if (sources) return fail(sources);
  const count = list(body.sources).length;
  return {
    ok: true,
    detail: `${count} sources${tokens ? `, ${tokens.input}/${tokens.output} tokens` : ''}${unproven}`,
    ...withTokens,
  };
};

export const parseSse = (text: string): { frames: Record<string, unknown>[]; done: boolean } => {
  const frames: Record<string, unknown>[] = [];
  let done = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') done = true;
    else {
      const frame = json(data);
      if (frame && typeof frame === 'object') frames.push(record(frame));
    }
  }
  return { frames, done };
};

export const assessStream = (result: HttpResult, expect: Expect): Verdict => {
  const task = taskOf(result);
  const withTask = task ? { task } : {};
  if (result.status !== 200)
    return { ok: false, detail: errorText(result), retry: isTransient(result), ...withTask };
  const { frames, done } = parseSse(result.text);
  const fail = (detail: string): Verdict => ({ ok: false, detail, retry: true, ...withTask });
  const finishes = frames.map((f) => record(list(f.choices)[0]).finish_reason).filter(Boolean);
  const error = frames.find((f) => record(list(f.choices)[0]).finish_reason === 'error');
  if (error) {
    const e = record(error.error);
    return fail(`stream ended in error ${clip(String(e.failure_code ?? e.code ?? ''))}`);
  }
  if (!done || !finishes.includes('stop')) return fail('stream did not finish with stop');
  const content = frames
    .map((f) => record(record(list(f.choices)[0]).delta).content)
    .filter((c): c is string => typeof c === 'string')
    .join('');
  if (expect.answer && !content.trim()) return fail('empty answer');
  const steps = frames.filter((f) => f.genai_step !== undefined).length;
  if (steps === 0) return fail('no step frames');
  const sources = frames.flatMap((f) => list(f.sources));
  const missing = sourceCheck(sources, expect);
  if (missing) return fail(missing);
  return { ok: true, detail: `${steps} steps, ${sources.length} sources`, ...withTask };
};

export const detectionsOf = (timeline: Record<string, unknown>): string[] =>
  list(timeline.steps).flatMap((step) =>
    list(record(step).blocks)
      .map(record)
      .filter((b) => b.kind === 'tags' && detectedLabels.includes(String(b.label)))
      .flatMap((b) => list(b.items).map(String)),
  );

export const assessTimeline = (
  result: HttpResult,
  expect: { detected?: string[]; tokens: boolean },
): Verdict & { unavailable?: boolean } => {
  if ([401, 403].includes(result.status))
    return {
      ok: false,
      unavailable: true,
      detail: `the key cannot read a run's timeline (${result.status})`,
    };
  if (result.status !== 200) return { ok: false, detail: `timeline answered ${result.status}` };
  const timeline = record(json(result.text));
  if (timeline.status !== 'completed')
    return { ok: false, detail: `status ${clip(String(timeline.status))}` };
  const steps = list(timeline.steps).length;
  if (steps === 0) return { ok: false, detail: 'no steps' };
  if (expect.tokens && !(Number(timeline.inputTokens) > 0))
    return { ok: false, detail: 'no input tokens on the timeline' };
  const found = detectionsOf(timeline);
  if (expect.detected?.length === 0 && found.length)
    return { ok: false, detail: `unexpected detection ${clip(found.join('; '))}`, retry: true };
  const missing = (expect.detected ?? []).filter((v) => !found.some((f) => f.includes(v)));
  if (missing.length)
    return { ok: false, detail: `not detected: ${missing.join(', ')}`, retry: true };
  return {
    ok: true,
    detail: `${steps} steps${found.length ? `, detected ${clip(found.join('; '), 120)}` : ''}`,
  };
};

export const outcomeOf = (passes: boolean[]): Outcome => {
  if (passes[0]) return 'pass';
  return passes.at(-1) ? 'flaky' : 'fail';
};

export const costOf = (tokens: Tokens | undefined, price: Price | undefined) =>
  tokens && price ? tokens.input * price.input + tokens.output * price.output : undefined;

export class Budget {
  readonly max: number;
  spent = 0;

  constructor(max: number) {
    this.max = max;
  }

  allows(estimate: number) {
    return this.spent + estimate <= this.max;
  }

  add(estimate: number, measured?: number) {
    this.spent += Math.max(estimate, measured ?? 0);
  }
}

export const overallOutcome = (checks: CheckResult[], tiers: Tier[]): SmokeReport['outcome'] => {
  if (checks.some((c) => c.outcome === 'fail')) return 'fail';
  const skipped = checks.some((c) => c.outcome === 'skip' && c.skipReason !== 'unavailable');
  return skipped || !tiers.includes('core') ? 'partial' : 'pass';
};

export interface ModelCheckDeps {
  budget: Budget;
  price: Price | undefined;
  deadline: number;
  attemptMs: number;
  retryMs: number;
  now(): number;
  wait(ms: number): Promise<void>;
}

export const runModelCheck = async (
  tier: Tier,
  id: string,
  estimate: number,
  attempt: () => Promise<Verdict>,
  deps: ModelCheckDeps,
): Promise<CheckResult> => {
  const passes: boolean[] = [];
  const tasks: string[] = [];
  let last: Verdict | undefined;
  let blocked: SkipReason | undefined;
  let tokens: Tokens | undefined;
  let cost = 0;
  for (let i = 0; i < 2; i++) {
    const delay = i > 0 ? deps.retryMs : 0;
    if (!deps.budget.allows(estimate)) blocked = 'budget';
    else if (deps.now() + delay + deps.attemptMs > deps.deadline) blocked = 'time';
    if (blocked) break;
    if (delay) await deps.wait(delay);
    last = await attempt();
    const measured = costOf(last.tokens, deps.price);
    deps.budget.add(estimate, measured);
    cost += measured ?? 0;
    if (last.task) tasks.push(last.task);
    if (last.tokens) tokens = last.tokens;
    passes.push(last.ok);
    if (last.ok || !last.retry) break;
  }
  const result: CheckResult = last
    ? { id, tier, outcome: outcomeOf(passes), detail: last.detail, attempts: passes.length, tasks }
    : {
        id,
        tier,
        outcome: 'skip',
        skipReason: blocked ?? 'budget',
        detail: blocked === 'time' ? 'the run is out of time' : 'it would pass the per-run budget',
        attempts: 0,
        tasks,
      };
  if (tokens) result.tokens = tokens;
  if (cost) result.costKr = cost;
  return result;
};
