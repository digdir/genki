import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pricedUsage, unitPricesFor, type PriceSpec } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const configDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'local');
const prices = (
  parse(readFileSync(join(configDir, 'prices.yaml'), 'utf8')) as {
    models: Record<string, PriceSpec>;
  }
).models;

const offered = [
  'ai-gateway/aivar-borealis',
  'ai-gateway/sigma2-borealis-27b',
  'ai-gateway/sigma2-borealis2-preview',
  'ai-gateway/sigma2-clef-flash',
  'ai-gateway/sigma2-deepseek-v4-flash',
  'ai-gateway/sigma2-qwen3.8-27b',
  'foundry-claude/claude-fable-5-1',
  'foundry-claude/claude-haiku-5-5',
  'foundry-claude/claude-opus-5-5',
  'foundry-claude/claude-sonnet-5-5',
  'foundry-openai/gpt-5.4',
  'foundry-openai/gpt-5.4-mini',
  'foundry-openai/gpt-5.4-nano',
  'foundry-openai/gpt-5.4-pro',
  'foundry-openai/gpt-5.5',
  'foundry-openai/gpt-5.6-terra',
  'foundry-openai/gpt-6-astra',
  'foundry-openai/gpt-6-luna',
  'foundry-openai/gpt-6-sol',
  'foundry-openai/gpt-6.1-sol',
  'foundry-openai/gpt-6.1-terra',
  'foundry-openai/gpt-audio-1.5',
  'foundry-openai/gpt-image-1.5',
  'foundry-openai/gpt-image-2',
  'foundry-openai/gpt-transcribe',
  'foundry-openai/model-router',
];

const notPriced: Record<string, string> = {
  'ai-gateway/sigma2-clef-flash': 'AI gateway model without a price entry yet',
  'ai-gateway/sigma2-deepseek-v4-flash': 'AI gateway model without a price entry yet',
  'foundry-openai/gpt-audio-1.5': 'no price found',
  'foundry-openai/gpt-image-1.5': 'no entry in this file',
  'foundry-openai/gpt-transcribe': 'billed per hour but reports tokens, not seconds',
  'foundry-openai/model-router': 'its price is a surcharge on top of the models it routes to',
};

describe('model prices', () => {
  it('every model the platform offers has a price or is listed as not priced with a reason', () => {
    const missing = offered.filter((id) => !prices[id] && !notPriced[id]);
    expect(missing).toEqual([]);
  });

  it('a model listed as not priced has no price in the file', () => {
    expect(Object.keys(notPriced).filter((id) => prices[id])).toEqual([]);
  });

  it('a run on claude-opus-5-5 costs its Anthropic rates in kroner', () => {
    const opus = unitPricesFor(prices['foundry-claude/claude-opus-5-5'], 'chat');
    const run = pricedUsage(
      { inputTokens: 100_000, outputTokens: 10_000, cachedInputTokens: 40_000, requests: 1 },
      opus,
    );
    const usd = 60_000 * 4e-6 + 40_000 * 0.2e-6 + 10_000 * 20e-6;
    expect(run.costMicroNok).toBe(Math.round(usd * 9.27 * 1_000_000));
  });

  it('a run on gpt-image-2 prices text input, image input and image output', () => {
    const edit = unitPricesFor(prices['foundry-openai/gpt-image-2'], 'edit-image');
    const run = pricedUsage(
      {
        inputTokens: 1000,
        requests: 1,
        units: { 'image-input-token': 2000, 'image-output-token': 4000 },
      },
      edit,
    );
    const usd = 1000 * 5e-6 + 2000 * 8e-6 + 4000 * 30e-6;
    expect(run.costMicroNok).toBe(Math.round(usd * 9.27 * 1_000_000));
  });
});
