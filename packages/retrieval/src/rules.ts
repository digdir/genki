import type { FilterClause } from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import { z } from 'zod';
import { tokenize } from './text.js';

const markerWordRule = z.strictObject({
  type: z.literal('marker-word-classify'),
  field: z.string().min(1),
  values: z.record(
    z.string(),
    z.strictObject({
      markerWords: z.array(z.string()).default([]),
      requiresChars: z.string().optional(),
    }),
  ),
  minTokens: z.number().int().nonnegative().default(3),
  thresholdRatio: z.number().positive().default(2.0),
});

const shapePatternRule = z.strictObject({
  type: z.literal('shape-pattern'),
  field: z.string().min(1),
  mode: z.enum(['strict', 'permissive']).default('strict'),
  universe: z.array(z.string()).default([]),
  patterns: z.array(z.strictObject({ value: z.string(), regex: z.string().min(1) })).min(1),
});

const llmClassifyRule = z.strictObject({
  type: z.literal('llm-classify'),
  field: z.string().min(1),
  universe: z.array(z.string()).min(1),
  mode: z.enum(['strict', 'permissive']).default('strict'),
  temperature: z.number().min(0).max(2).default(0),
  promptTemplate: z.string().min(1),
  allowMultiValue: z.boolean().default(true),
});

export const autoFilterRule = z.discriminatedUnion('type', [
  markerWordRule,
  shapePatternRule,
  llmClassifyRule,
]);
export type AutoFilterRule = z.infer<typeof autoFilterRule>;

export const javaRegex = (source: string): RegExp => {
  const inline = /^\(\?([imsux]+)\)/.exec(source);
  const flags = new Set(['u']);
  for (const f of inline?.[1] ?? '') if (f === 'i' || f === 'm' || f === 's') flags.add(f);
  return new RegExp(inline ? source.slice(inline[0].length) : source, [...flags].join(''));
};

type Detected = { field: string; value: FilterClause };

const markerWords = (
  rule: z.infer<typeof markerWordRule>,
  queries: string[],
): Detected | undefined => {
  const text = queries.join(' ').toLowerCase();
  const tokens = tokenize(text);
  if (tokens.size < rule.minTokens) return undefined;
  const scored = Object.entries(rule.values).map(([value, spec]) => {
    const words = new Set(spec.markerWords.map((w) => w.toLowerCase()));
    return {
      value,
      overlap: [...tokens].filter((t) => words.has(t)).length,
      charMatch: spec.requiresChars !== undefined && javaRegex(spec.requiresChars).test(text),
    };
  });
  const charHit = scored.find((s) => s.charMatch);
  if (charHit) return { field: rule.field, value: [charHit.value] };
  const sorted = [...scored].sort((a, b) => b.overlap - a.overlap);
  const top = sorted[0];
  const runner = sorted[1]?.overlap ?? 0;
  return top && top.overlap >= 2 && top.overlap >= rule.thresholdRatio * Math.max(1, runner)
    ? { field: rule.field, value: [top.value] }
    : undefined;
};

const restrict = (
  field: string,
  selected: string[],
  universe: string[],
  mode: 'strict' | 'permissive',
): Detected | undefined => {
  if (mode === 'permissive') {
    const complement = universe.filter((u) => !selected.includes(u));
    return complement.length > 0 ? { field, value: { not: complement } } : undefined;
  }
  return { field, value: selected };
};

const shapePattern = (
  rule: z.infer<typeof shapePatternRule>,
  queries: string[],
): Detected | undefined => {
  const text = queries.join(' ');
  const match = rule.patterns.find((p) => javaRegex(p.regex).test(text));
  return match ? restrict(rule.field, [match.value], rule.universe, rule.mode) : undefined;
};

export const renderClassifyPrompt = (
  template: string,
  field: string,
  universe: string[],
  queries: string[],
) =>
  template
    .replaceAll('{{field}}', field)
    .replaceAll('{{universe-joined}}', universe.join(', '))
    .replaceAll('{{query}}', queries.join(' '));

const classify = async (
  rule: z.infer<typeof llmClassifyRule>,
  queries: string[],
  model: ModelPort,
): Promise<string[] | undefined> => {
  try {
    const answer = await model.chat({
      messages: [
        {
          role: 'user',
          content: renderClassifyPrompt(rule.promptTemplate, rule.field, rule.universe, queries),
        },
      ],
      temperature: rule.temperature,
      jsonSchema: {
        name: 'classify',
        schema: {
          type: 'object',
          properties: { values: { type: 'array', items: { type: 'string', enum: rule.universe } } },
          required: ['values'],
          additionalProperties: false,
        },
      },
    });
    const values = (JSON.parse(answer.content) as { values?: unknown }).values;
    return Array.isArray(values) ? values.map(String) : [];
  } catch {
    return undefined;
  }
};

const llmClassify = async (
  rule: z.infer<typeof llmClassifyRule>,
  queries: string[],
  model: ModelPort | undefined,
): Promise<Detected | undefined> => {
  if (!model || queries.length === 0 || rule.promptTemplate.trim() === '') return undefined;
  const raw = await classify(rule, queries, model);
  if (raw === undefined) return undefined;
  const selected = [...new Set(rule.allowMultiValue ? raw : raw.slice(0, 1))].filter((v) =>
    rule.universe.includes(v),
  );
  return selected.length > 0 ? restrict(rule.field, selected, rule.universe, rule.mode) : undefined;
};

export const detectFromRules = async (
  rules: AutoFilterRule[],
  queries: string[],
  model: ModelPort | undefined,
): Promise<Record<string, FilterClause>> => {
  const detected: Record<string, FilterClause> = {};
  for (const rule of rules) {
    const found =
      rule.type === 'marker-word-classify'
        ? markerWords(rule, queries)
        : rule.type === 'shape-pattern'
          ? shapePattern(rule, queries)
          : await llmClassify(rule, queries, model);
    if (found) detected[found.field] = found.value;
  }
  return detected;
};
