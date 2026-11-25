import { describe, expect, it } from 'vitest';
import { parseFrameMessage } from './block-bridge.js';

describe('messages from a block frame', () => {
  it('takes the bridge messages in their exact shape', () => {
    expect(parseFrameMessage({ genki: 1, type: 'ready' })).toEqual({ genki: 1, type: 'ready' });
    expect(parseFrameMessage({ genki: 1, type: 'resize', height: 240 })).toEqual({
      genki: 1,
      type: 'resize',
      height: 240,
    });
    expect(
      parseFrameMessage({ genki: 1, type: 'event', name: 'ask', payload: { question: 'Hva?' } }),
    ).toEqual({ genki: 1, type: 'event', name: 'ask', payload: { question: 'Hva?' } });
  });

  it('drops a message of any other shape', () => {
    const malformed: unknown[] = [
      'ready',
      null,
      [],
      { type: 'ready' },
      { genki: 2, type: 'ready' },
      { genki: 1, type: 'ready', extra: true },
      { genki: 1, type: 'render' },
      { genki: 1, type: 'resize', height: 2_001 },
      { genki: 1, type: 'resize', height: -1 },
      { genki: 1, type: 'resize', height: 1.5 },
      { genki: 1, type: 'event', name: 'fetch', payload: {} },
      { genki: 1, type: 'event', name: 'ask', payload: { question: 'x'.repeat(2_001) } },
      { genki: 1, type: 'event', name: 'ask', payload: { question: '   ' } },
      { genki: 1, type: 'event', name: 'ask', payload: { question: 'Hva?', send: true } },
      { genki: 1, type: 'event', name: 'open-document', payload: { source: '1' } },
      { genki: 1, type: 'event', name: 'notify', payload: { text: 'x'.repeat(201) } },
      { genki: 1, type: 'event', name: 'set-filter', payload: { field: 'år', values: [1] } },
      Object.assign(Object.create({ genki: 1 }), { type: 'ready' }),
    ];

    for (const message of malformed) expect(parseFrameMessage(message)).toBeUndefined();
  });
});
