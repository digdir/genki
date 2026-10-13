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

export const rejectedParameter = (
  status: number | undefined,
  message: string,
): 'temperature' | undefined =>
  status === 400 &&
  /temperature/i.test(message) &&
  /unsupported|not support|deprecated|only the default/i.test(message)
    ? 'temperature'
    : undefined;
