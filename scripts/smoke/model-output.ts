// Takes a model job's structured output and cost from the action's execution file.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ModelOutput {
  output: unknown;
  costUsd: number | null;
}

export const modelOutputOf = (execution: unknown): ModelOutput => {
  const messages = Array.isArray(execution) ? (execution as Record<string, unknown>[]) : [];
  const result = messages.find((m) => m && typeof m === 'object' && m.type === 'result');
  let output: unknown = result?.structured_output;
  if (output === undefined && typeof result?.result === 'string')
    try {
      output = JSON.parse(result.result);
    } catch {
      output = undefined;
    }
  const cost = result?.total_cost_usd;
  return { output: output ?? {}, costUsd: typeof cost === 'number' ? cost : null };
};

export const main = () => {
  const [, , target] = process.argv;
  const path = process.env.EXECUTION;
  if (!target) throw new Error('usage: model-output.ts <target file>');
  let execution: unknown;
  try {
    execution = path ? JSON.parse(readFileSync(path, 'utf8')) : [];
  } catch {
    execution = [];
  }
  writeFileSync(target, JSON.stringify(modelOutputOf(execution)));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
