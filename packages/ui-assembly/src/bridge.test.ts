import { bridgeLimits, type RenderMessage } from '@genai/contracts/block-bridge';
import { describe, expect, it } from 'vitest';
import { fitRender } from './bridge.js';

const message = (data: RenderMessage['data']): RenderMessage => ({
  genki: 1,
  type: 'render',
  state: 'filled',
  locale: 'nb',
  colorScheme: 'light',
  theme: {},
  props: {},
  texts: {},
  data,
});

const bytes = (m: RenderMessage) => new TextEncoder().encode(JSON.stringify(m)).length;

describe('a render message', () => {
  it('is cut to 64 KiB by halving the sources first, then the text', () => {
    const sources = Array.from({ length: 200 }, (_, i) => ({
      index: i + 1,
      title: `Kilde ${i + 1} ${'x'.repeat(400)}`,
    }));
    const fitted = fitRender(message({ sources, answer: { text: 'svar '.repeat(30_000) } }));

    expect(bytes(fitted)).toBeLessThanOrEqual(bridgeLimits.renderMessageBytes);
    expect(fitted.data.sources).toHaveLength(0);
    expect(fitted.data.answer?.text.startsWith('svar svar')).toBe(true);
  });

  it('is left as it is within 64 KiB', () => {
    const small = message({ question: { text: 'Hva er klarspråk?' } });

    expect(fitRender(small)).toBe(small);
  });
});
