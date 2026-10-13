import type { Input } from '@genai/contracts';
import type { InvocationContext, Strategy } from '@genai/kernel';
import { z } from 'zod';
import { untrusted } from './prompt.js';
import { platformModel, type PlatformServiceConfig } from './strategy.js';

export interface ImprovementFailure {
  input: string;
  expected: string;
  output: string;
  reason?: string;
}

export interface ImprovementFeedback {
  comment?: string;
  reasons?: string[];
}

export interface ImprovementEvidence {
  purpose: string;
  language?: string;
  instructions: string;
  feedback: ImprovementFeedback[];
  failures: ImprovementFailure[];
}

export interface InstructionChange {
  after: string;
  reasons: string[];
}

export const optimiserStrategyId = 'optimiser';
export const optimiserServiceId = 'optimiser';
export const optimiserResultMime = 'application/vnd.genai.instruction-change+json';

export interface OptimiserResult {
  changed: boolean;
  changes: 'instructions'[];
  instructions?: string;
  reasons: string[];
  refused: 'secrets' | 'no-change' | null;
}

export const maxEvidence = { feedback: 20, failures: 10 } as const;

export const optimiserInput = z.object({
  evidence: z.object({
    purpose: z.string(),
    language: z.enum(['nb', 'nn', 'en']).optional(),
    instructions: z.string().min(1),
    feedback: z.array(
      z.object({ comment: z.string().optional(), reasons: z.array(z.string()).optional() }),
    ),
    failures: z.array(
      z.object({
        input: z.string(),
        expected: z.string(),
        output: z.string(),
        reason: z.string().optional(),
      }),
    ),
  }),
});

const languageNames: Record<string, string> = {
  nb: 'bokmål',
  nn: 'nynorsk',
  en: 'engelsk',
};

export const instructionChangeRequest = (evidence: ImprovementEvidence) =>
  [
    `Formål:\n${evidence.purpose}`,
    ...(evidence.language
      ? [
          `Språk: ${languageNames[evidence.language] ?? evidence.language}. Teksten under legges til tjenestens felles instruksjoner når svaret skrives på dette språket. Foreslå bare endringer i denne teksten.`,
        ]
      : []),
    `Dagens instruksjoner:\n${untrusted('instructions', evidence.instructions)}`,
    `Negative tilbakemeldinger:\n${untrusted('feedback', evidence.feedback.slice(0, maxEvidence.feedback))}`,
    `Testtilfeller som feilet:\n${untrusted('failures', evidence.failures.slice(0, maxEvidence.failures))}`,
  ].join('\n\n');

export const parseInstructionChange = (
  reply: string,
  before: string,
): InstructionChange | undefined => {
  const body = /\{[\s\S]*\}/.exec(reply)?.[0];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { instructions, reasons } = parsed as { instructions?: unknown; reasons?: unknown };
  if (typeof instructions !== 'string') return undefined;
  const after = instructions.trim();
  if (!after || after === before.trim()) return undefined;
  return {
    after,
    reasons: Array.isArray(reasons)
      ? reasons.filter((r): r is string => typeof r === 'string' && r.trim() !== '').slice(0, 10)
      : [],
  };
};

const secretReference = /\bsecret:/i;

export const optimiserResult = (reply: string, before: string): OptimiserResult => {
  const change = parseInstructionChange(reply, before);
  if (!change) return { changed: false, changes: [], reasons: [], refused: 'no-change' };
  if (secretReference.test(change.after))
    return { changed: false, changes: [], reasons: [], refused: 'secrets' };
  return {
    changed: true,
    changes: ['instructions'],
    instructions: change.after,
    reasons: change.reasons,
    refused: null,
  };
};

export const createOptimiser = (): Strategy<PlatformServiceConfig> => ({
  id: optimiserStrategyId,
  version: '1',
  requires: { kernel: 1, ports: ['model'], features: [] },
  run: async function* (ctx: InvocationContext, input: Input, config: PlatformServiceConfig) {
    const { evidence } = optimiserInput.parse(input.data) as { evidence: ImprovementEvidence };
    const model = await platformModel(ctx, config);
    const reply = await model.chat({
      messages: [
        { role: 'system', content: config.strategy.instructions },
        { role: 'user', content: instructionChangeRequest(evidence) },
      ],
    });
    yield {
      type: 'kernel.result',
      data: [
        {
          mime: optimiserResultMime,
          body: { kind: 'json', json: optimiserResult(reply.content, evidence.instructions) },
        },
      ],
    };
  },
});
