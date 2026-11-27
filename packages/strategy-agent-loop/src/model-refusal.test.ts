import { describe, expect, it } from 'vitest';
import type { ChatResult } from '@genai/port-model';
import { modelRefusals } from './index.js';
import {
  allSupported,
  baseConfig,
  call,
  decision,
  readSignal,
  result,
  run,
} from './harness.test-utils.js';

const refused = (category?: string): ChatResult => ({
  ...result(''),
  finishReason: 'content_filter',
  usage: { inputTokens: 4923, outputTokens: 0, requests: 1 },
  ...(category ? { stopDetail: { category } } : {}),
});

const guarded = {
  ...baseConfig,
  strategy: { ...baseConfig.strategy, noToolCallRetry: true },
};

describe('a model refusal', () => {
  it('answers with the refusal text and no fallback call when the model refuses with no text', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => refused('reasoning_extraction'),
          ],
        },
      },
    });

    expect(out.notices).toContainEqual(
      expect.objectContaining({ stage: 'model-refused', category: 'reasoning_extraction' }),
    );
    expect(out.notices.map((n) => n.stage)).not.toContain('recovered-empty');
    expect(out.seen.map((s) => s.kind)).not.toContain('final');
    expect(out.text).toBe(modelRefusals.nb);
  });

  it('does not retry a refused turn with the no-tool-call nudge', async () => {
    const out = await run({
      config: guarded,
      scripts: {
        primary: { loop: [() => refused('reasoning_extraction'), () => result('Svar.')] },
      },
    });

    expect(out.loops).toHaveLength(1);
    expect(out.seen.map((s) => s.kind)).toEqual(['loop']);
    expect(out.text).toBe(modelRefusals.nb);
  });

  it('answers in the language of the question', async () => {
    const out = await run({
      question: 'What does the allocation letter for Digdir say?',
      scripts: { primary: { loop: [() => refused()] } },
    });

    expect(out.notices).toContainEqual({ stage: 'model-refused', iteration: 0 });
    expect(out.text).toBe(modelRefusals.en);
  });

  it('does not mark a model refusal as found nothing', async () => {
    const out = await run({
      config: {
        ...guarded,
        strategy: { ...guarded.strategy, noAnswerText: 'Kudos dekker ikke dette.' },
      },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => refused('reasoning_extraction'),
          ],
        },
      },
    });

    expect(out.text).toBe(modelRefusals.nb);
    expect(out.meta?.noAnswer).toBeUndefined();
  });

  it('answers a refusal in nynorsk', async () => {
    const out = await run({
      question: 'Kva seier tildelingsbrevet til Digdir for 2025?',
      scripts: { primary: { loop: [() => refused()] } },
    });

    expect(out.text).toBe(modelRefusals.nn);
  });

  it('treats a refused draft as a refusal, without another round or fallback call', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('Svar.'),
          ],
          read: [() => readSignal('gap-remaining')],
          synth: [() => refused('reasoning_extraction')],
        },
      },
    });

    expect(out.notices).toContainEqual(
      expect.objectContaining({ stage: 'model-refused', category: 'reasoning_extraction' }),
    );
    expect(out.loops).toHaveLength(3);
    expect(out.seen.map((s) => s.kind)).not.toContain('final');
    expect(out.text).toBe(modelRefusals.nb);
  });

  it('treats a refused fallback call as a refusal', async () => {
    const out = await run({
      scripts: { primary: { loop: [() => result('')], final: refused('general_harms') } },
    });

    expect(out.notices).toContainEqual(
      expect.objectContaining({ stage: 'model-refused', category: 'general_harms' }),
    );
    expect(out.text).toBe(modelRefusals.nb);
  });

  it('shows a refusal when the draft the loop writes after a finalize verdict is refused', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3', 'c4', 'c5'] })]),
            // The read check runs alongside this turn and gives its verdict after it.
            () => result('', [call('search', { queries: ['y'] })]),
            () => result('Svar.'),
          ],
          read: [allSupported],
          sufficiency: [() => decision('sufficient', 'finalize')],
          synth: [() => refused('cyber')],
        },
      },
    });

    expect(out.notices).toContainEqual(
      expect.objectContaining({ stage: 'model-refused', category: 'cyber' }),
    );
    expect(out.text).toBe(modelRefusals.nb);
  });

  it('keeps an earlier cited draft when a later draft is refused', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('Svar.'),
          ],
          read: [() => readSignal('gap-remaining')],
          synth: [() => 'Svar fra utkastet [1].', () => refused('general_harms')],
          sufficiency: [() => decision('insufficient', 're-search')],
        },
      },
    });

    expect(out.notices).toContainEqual(
      expect.objectContaining({ stage: 'model-refused', category: 'general_harms' }),
    );
    expect(out.text).toBe('Svar fra utkastet [1].');
  });

  it('does not treat a filtered turn that still calls tools as a refusal', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => ({ ...refused(), toolCalls: [call('search', { queries: ['x'] })] }),
            () => result('Svar.'),
          ],
        },
      },
    });

    expect(out.notices.map((n) => n.stage)).not.toContain('model-refused');
  });

  it('keeps a usable earlier draft when a later turn is refused', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => refused('general_harms'),
          ],
          read: [() => readSignal('gap-remaining')],
          synth: [() => 'Svar fra utkastet [1].'],
          sufficiency: [() => decision('insufficient', 're-search')],
        },
      },
    });

    expect(out.notices).toContainEqual(
      expect.objectContaining({ stage: 'model-refused', category: 'general_harms' }),
    );
    expect(out.text).toBe('Svar fra utkastet [1].');
  });

  it('keeps text the model wrote before it refused, as today', async () => {
    const out = await run({
      scripts: {
        primary: { loop: [() => ({ ...refused('cyber'), content: 'Første del av svaret.' })] },
      },
    });

    expect(out.notices.map((n) => n.stage)).not.toContain('model-refused');
    expect(out.text).toBe('Første del av svaret.');
  });
});
