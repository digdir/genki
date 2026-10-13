import { z } from 'zod';

export const ruleId = z.string().regex(/^(\d{9}\/)?[a-z0-9][a-z0-9-]{0,62}$/);

const stage = z.enum(['input', 'output', 'both']).default('input');
const message = z.string().min(1).max(1000).optional();
const description = z.string().min(1).max(1000).optional();
const onError = z.enum(['refuse', 'allow']).default('refuse');
const action = z.enum(['refuse', 'mask']).default('refuse');
const mask = z.string().max(100).default('[fjernet]');

const compiles = (pattern: string, flags = '') => {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
};

const regexRule = z
  .strictObject({
    kind: z.literal('regex'),
    pattern: z.string().min(1).max(500),
    flags: z
      .string()
      .regex(/^[imsu]*$/)
      .default('i'),
    stage,
    action,
    mask,
    message,
    description,
  })
  .refine((r) => compiles(r.pattern, r.flags), {
    message: 'not a valid regular expression',
    path: ['pattern'],
  });

const denylistRule = z.strictObject({
  kind: z.literal('denylist'),
  terms: z.array(z.string().min(1).max(200)).min(1).max(500),
  wholeWords: z.boolean().default(true),
  stage,
  action,
  mask,
  message,
  description,
});

const judgeRule = z.strictObject({
  kind: z.literal('llm-judge'),
  prompt: z.string().min(1).max(4000),
  stage,
  onError,
  message,
  description,
});

const mcpRule = z.strictObject({
  kind: z.literal('mcp-check'),
  tool: z.string().regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9_-]+@\d+(\.\d+){0,2}$/),
  stage,
  onError,
  message,
  description,
});

export const customRuleSpec = z.union([regexRule, denylistRule, judgeRule, mcpRule]);
export type CustomRuleSpec = z.infer<typeof customRuleSpec>;
export type CustomRule = CustomRuleSpec & { id: string; owner?: string };

export const ruleKinds = ['regex', 'denylist', 'llm-judge', 'mcp-check'] as const;

const inlineRuleSchema = z.looseObject({ id: ruleId }).superRefine((value, ctx) => {
  const parsed = customRuleSpec.safeParse(
    Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'id')),
  );
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});

export const customRulesConfig = z
  .array(z.union([ruleId, inlineRuleSchema]))
  .min(1)
  .max(50);

export const inlineRule = (entry: unknown): CustomRule | undefined => {
  if (typeof entry === 'string') return undefined;
  const { id, ...rest } = entry as { id: string };
  return { ...customRuleSpec.parse(rest), id };
};

export interface RuleVerdict {
  allow: boolean;
  message?: string;
}

export interface RuleRuntime {
  judge(rule: Extract<CustomRule, { kind: 'llm-judge' }>, text: string): Promise<RuleVerdict>;
  external(rule: Extract<CustomRule, { kind: 'mcp-check' }>, text: string): Promise<RuleVerdict>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const matcher = (rule: CustomRule): RegExp | undefined => {
  if (rule.kind === 'regex') return new RegExp(rule.pattern, `${rule.flags.replace('g', '')}g`);
  if (rule.kind === 'denylist') {
    const alternatives = rule.terms.map(escape).join('|');
    return new RegExp(
      rule.wholeWords
        ? `(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`
        : `(?:${alternatives})`,
      'giu',
    );
  }
  return undefined;
};

export const appliesTo = (rule: CustomRule, at: 'input' | 'output') =>
  rule.stage === 'both' || rule.stage === at;

export type RuleOutcome =
  | { refused: true; rule: string; message?: string }
  | { refused: false; text: string; masked: string[] };

const maxChecked = 20_000;

export const applyRules = async (
  rules: CustomRule[],
  at: 'input' | 'output',
  text: string,
  runtime: RuleRuntime,
): Promise<RuleOutcome> => {
  let current = text;
  const masked: string[] = [];
  for (const rule of rules.filter((r) => appliesTo(r, at))) {
    const checked = current.slice(0, maxChecked);
    const pattern = matcher(rule);
    if (pattern) {
      const mode = (rule as { action: 'refuse' | 'mask' }).action;
      if (mode === 'mask' && at === 'output') {
        const next = current.replace(pattern, (rule as { mask: string }).mask);
        if (next !== current) masked.push(rule.id);
        current = next;
        continue;
      }
      if (pattern.test(checked))
        return { refused: true, rule: rule.id, ...(rule.message ? { message: rule.message } : {}) };
      continue;
    }
    let verdict: RuleVerdict;
    try {
      verdict =
        rule.kind === 'llm-judge'
          ? await runtime.judge(rule, checked)
          : await runtime.external(rule as Extract<CustomRule, { kind: 'mcp-check' }>, checked);
    } catch {
      verdict = { allow: (rule as { onError: string }).onError === 'allow' };
    }
    if (!verdict.allow)
      return {
        refused: true,
        rule: rule.id,
        ...((rule.message ?? verdict.message) ? { message: rule.message ?? verdict.message } : {}),
      };
  }
  return { refused: false, text: current, masked };
};
