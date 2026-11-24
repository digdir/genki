import { describe, expect, it } from 'vitest';
import { identityOf, makerOf, readableModelName } from './model-identity.js';

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('readable model names', () => {
  it.each([
    ['gpt-6-luna', 'GPT-6 Luna'],
    ['gpt-5.4-mini', 'GPT-5.4 Mini'],
    ['gpt-audio-1.5', 'GPT Audio 1.5'],
    ['claude-fable-5-1', 'Claude Fable 5.1'],
    ['aivar:borealis', 'Borealis'],
    ['sigma2:borealis-27b', 'Borealis 27B'],
    ['sigma2:borealis2-preview', 'Borealis 2 Preview'],
    ['sigma2:qwen3.8-27b', 'Qwen 3.8 27B'],
    ['meta-llama/Llama-3.1-8B', 'Llama 3.1 8B'],
    ['model-router', 'Model Router'],
    ['o4-mini', 'o4 Mini'],
    ['gpt-4o-2024-08-06', 'GPT-4o'],
    ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
    ['llama3.1:8b', 'Llama 3.1 8B'],
  ])('names %s as %s', (raw, name) => {
    expect(readableModelName(raw)).toBe(name);
  });

  it('names a model in linear time on a long adversarial deployment name', () => {
    const long = `${'a'.repeat(50_000)}1${'-1'.repeat(25_000)}:${'b9'.repeat(25_000)}`;
    expect(quickly(() => readableModelName(long))).toBeLessThan(1000);
    expect(quickly(() => makerOf({ deployment: long }))).toBeLessThan(1000);
  });
});

describe('who made a model', () => {
  it('keeps the maker the catalogue names', () => {
    expect(makerOf({ deployment: 'gpt-6-luna', maker: 'Egen' })).toBe('Egen');
  });

  it.each([
    ['gpt-6-luna', 'OpenAI'],
    ['claude-opus-5-5', 'Anthropic'],
    ['sigma2:qwen3.8-27b', 'Alibaba'],
    ['aivar:borealis', 'NbAiLab'],
    ['meta-llama/Llama-3.1-8B', 'Meta'],
  ])('reads the maker of %s from its name', (deployment, maker) => {
    expect(makerOf({ deployment })).toBe(maker);
  });

  it('says nothing for a name it does not know', () => {
    expect(makerOf({ deployment: 'model-router' })).toBeUndefined();
  });
});

describe('who runs a model', () => {
  it('names the host a gateway deployment starts with, over the connection operator', () => {
    expect(
      identityOf(
        { deployment: 'aivar:borealis', operator: { name: 'Gatewayen' } },
        { baseURL: 'https://gateway.example/v1', gateway: true },
      ),
    ).toEqual({
      maker: 'NbAiLab',
      operator: { name: 'Digdir', region: 'Leikanger' },
      gateway: true,
    });
  });

  it('ignores a host prefix on a connection that is not the gateway', () => {
    expect(
      identityOf({ deployment: 'aivar:borealis' }, { baseURL: 'https://own.example/v1' }),
    ).toEqual({ maker: 'NbAiLab' });
  });

  it('keeps the operator the connection names for other models', () => {
    expect(
      identityOf(
        { deployment: 'gpt-6-luna', operator: { name: 'Microsoft Azure', region: 'Sverige' } },
        { baseURL: 'https://res.services.ai.azure.com' },
      ).operator,
    ).toEqual({ name: 'Microsoft Azure', region: 'Sverige' });
  });

  it('names Azure AI Foundry from the connection address when the connection names no operator', () => {
    expect(
      identityOf(
        { deployment: 'gpt-6-luna' },
        { baseURL: 'https://res.openai.azure.com/openai/v1' },
      ).operator,
    ).toEqual({ name: 'Azure AI Foundry' });
  });

  it('leaves the operator out when nothing says who runs the model', () => {
    expect(identityOf({ deployment: 'echo' }, { baseURL: 'http://localhost:9000' })).toEqual({});
  });
});
