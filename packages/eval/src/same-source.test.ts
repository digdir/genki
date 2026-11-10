import { describe, expect, it } from 'vitest';
import { textPart, type Event } from '@genai/contracts';
import { defaultObserve, sameSource } from './observe.js';
import { sourceRef } from './schema.js';

const expected = sourceRef.parse({
  document: 'kudos:de77ffc7-1a57-456a-af49-167e699a4e6e',
  earlierDocument: '377252',
  page: 4,
});

describe('matching a source', () => {
  it('a source matches an expected document by its earlier id', () => {
    expect(sameSource(expected, { document: '377252' })).toBe(true);
    expect(sameSource(expected, { document: 'kudos:de77ffc7-1a57-456a-af49-167e699a4e6e' })).toBe(
      true,
    );
    expect(sameSource(expected, { document: '377253' })).toBe(false);
  });

  it("a source's page counts only when the hit has one", () => {
    const uuid = 'kudos:de77ffc7-1a57-456a-af49-167e699a4e6e';
    expect(sameSource(expected, { document: uuid, page: 4 })).toBe(true);
    expect(sameSource(expected, { document: uuid, page: 5 })).toBe(false);
    expect(sameSource(expected, { document: '377252' })).toBe(true);

    const observed = defaultObserve(
      [textPart('Svar')],
      [
        {
          seq: 1,
          ts: '2026-11-04T12:00:00.000Z',
          type: 'kernel.notice',
          data: { kind: 'retrieval', hits: [{ id: 'c1', document: uuid, page: 5 }] },
        } as Event,
      ],
    );
    expect(observed.retrieved.some((hit) => sameSource(expected, hit))).toBe(false);
  });

  it('a source copied under a new chunk id matches by its document and position', () => {
    const typesense = sourceRef.parse({
      chunkId: 'f0932e68f724',
      document: '377252',
      position: 437,
    });
    expect(sameSource(typesense, { chunkId: 'f0932e68f724' })).toBe(true);
    expect(
      sameSource(typesense, { chunkId: '9c1d0b7e2a44', document: '377252', position: 437 }),
    ).toBe(true);
    expect(
      sameSource(typesense, { chunkId: '9c1d0b7e2a44', document: '377252', position: 438 }),
    ).toBe(false);
    expect(
      sameSource(typesense, { chunkId: '9c1d0b7e2a44', document: '377253', position: 437 }),
    ).toBe(false);
  });

  it('a chunk id that differs never matches by document alone', () => {
    const noPosition = sourceRef.parse({ chunkId: 'f0932e68f724', document: '377252' });
    expect(
      sameSource(noPosition, { chunkId: '9c1d0b7e2a44', document: '377252', position: 437 }),
    ).toBe(false);
  });
});
