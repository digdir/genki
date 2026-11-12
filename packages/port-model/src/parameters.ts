import { z } from 'zod';
import type { ChatRequest } from './port.js';

export const tunableParameters = ['temperature', 'reasoning', 'maxTokens'] as const;
export type TunableParameter = (typeof tunableParameters)[number];

export const parameterRule = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('unsupported') }),
  z.strictObject({ mode: z.literal('fixed'), value: z.union([z.number(), z.string().min(1)]) }),
]);

export const parameterRules = z.strictObject({
  temperature: parameterRule.optional(),
  reasoning: parameterRule.optional(),
  maxTokens: parameterRule.optional(),
});

export type ParameterRule = z.infer<typeof parameterRule>;
export type ParameterRules = z.infer<typeof parameterRules>;

const valid: Record<TunableParameter, (value: unknown) => boolean> = {
  temperature: (v) => typeof v === 'number' && v >= 0 && v <= 2,
  reasoning: (v) => v === 'low' || v === 'medium' || v === 'high',
  maxTokens: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
};

export const parameterRuleProblems = (rules: ParameterRules): string[] =>
  tunableParameters.flatMap((name) => {
    const rule = rules[name];
    return rule?.mode === 'fixed' && !valid[name](rule.value)
      ? [`${name}: not a valid fixed value`]
      : [];
  });

export const applyParameterRules = (
  request: ChatRequest,
  rules: ParameterRules | undefined,
): ChatRequest => {
  if (!rules) return request;
  const kept = Object.entries(request).filter(
    ([key]) => rules[key as TunableParameter]?.mode !== 'unsupported',
  );
  const fixed = tunableParameters.flatMap((name) => {
    const rule = rules[name];
    return rule?.mode === 'fixed' ? [[name, rule.value] as const] : [];
  });
  return Object.fromEntries([...kept, ...fixed]) as unknown as ChatRequest;
};

const tokenParameters = ['max_completion_tokens', 'max_tokens'] as const;
export type TokenParameter = (typeof tokenParameters)[number];

const tokenRefusal = /extra_forbidden|extra inputs|unsupported|not supported|unrecognized|unknown/i;
const forbiddenInput = /extra_forbidden|extra inputs|not permitted/i;

const firstNamed = <T extends string>(diagnostic: string, names: readonly T[]): T | undefined =>
  names
    .map((name) => ({ name, at: diagnostic.indexOf(name) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)[0]?.name;

// Each diagnostic in a validation error ends at a closing brace, so a refusal is read per diagnostic.
const refusedTokenParameter = (message: string): TokenParameter | undefined => {
  for (const diagnostic of message.split('}')) {
    if (!tokenRefusal.test(diagnostic)) continue;
    const named = firstNamed(diagnostic, tokenParameters);
    if (named) return named;
  }
  return undefined;
};

const forbidsTemperature = (message: string): boolean =>
  message
    .split('}')
    .some(
      (diagnostic) =>
        forbiddenInput.test(diagnostic) &&
        firstNamed(diagnostic, ['temperature', ...tokenParameters]) === 'temperature',
    );

export const rejectedParameter = (
  status: number | undefined,
  message: string,
  param?: string | null,
): 'temperature' | TokenParameter | undefined => {
  if (
    status === 400 &&
    ((/temperature/i.test(message) &&
      /unsupported|not support|deprecated|only the default/i.test(message)) ||
      forbidsTemperature(message))
  )
    return 'temperature';
  if (status !== 400 && status !== 422) return undefined;
  const refused = refusedTokenParameter(message);
  return param && param !== refused ? undefined : refused;
};
