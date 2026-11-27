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
    const chunkRef = sourceRef.parse({
      chunkId: 'f0932e68f724',
      document: '377252',
      position: 437,
    });
    expect(sameSource(chunkRef, { chunkId: 'f0932e68f724' })).toBe(true);
    expect(
      sameSource(chunkRef, { chunkId: '9c1d0b7e2a44', document: '377252', position: 437 }),
    ).toBe(true);
    expect(
      sameSource(chunkRef, { chunkId: '9c1d0b7e2a44', document: '377252', position: 438 }),
    ).toBe(false);
    expect(
      sameSource(chunkRef, { chunkId: '9c1d0b7e2a44', document: '377253', position: 437 }),
    ).toBe(false);
  });

  it('a hit on a copied Kudos chunk matches the rewritten source', () => {
    // ka-kudos-027: Marker puts the old chunk on pages 25 to 26, Docling's page 26 holds most of it.
    const rewritten = sourceRef.parse({
      document: 'kudos:1c0ffee0-27aa-4bbb-8ccc-000000000027',
      earlierDocument: '82881',
      position: 58,
      page: 26,
    });
    const copied = defaultObserve(
      [textPart('Svar')],
      [
        {
          seq: 1,
          ts: '2026-11-20T10:00:00.000Z',
          type: 'kernel.notice',
          data: {
            kind: 'retrieval',
            hits: [
              {
                id: 'kudos:1c0ffee0-27aa-4bbb-8ccc-000000000027#58',
                document: 'kudos:1c0ffee0-27aa-4bbb-8ccc-000000000027',
                position: 58,
                page: 25,
                pageEnd: 26,
              },
            ],
          },
        } as Event,
      ],
    );
    expect(copied.retrieved.some((hit) => sameSource(rewritten, hit))).toBe(true);
  });

  it('a hit with a page matches a source on any page from its page to its pageEnd, whatever its position', () => {
    const source = sourceRef.parse({
      document: 'kudos:de77ffc7-1a57-456a-af49-167e699a4e6e',
      earlierDocument: '377252',
      position: 437,
      page: 245,
    });
    const document = 'kudos:de77ffc7-1a57-456a-af49-167e699a4e6e';
    expect(sameSource(source, { document, position: 241, page: 245 })).toBe(true);
    expect(sameSource(source, { document, position: 240, page: 244, pageEnd: 246 })).toBe(true);
    expect(sameSource(source, { document, position: 437, page: 251, pageEnd: 252 })).toBe(false);
    expect(sameSource(source, { document: '377252', position: 437 })).toBe(true);
    expect(sameSource(source, { document: '377252', position: 438 })).toBe(false);
  });

  it('a chunk id that differs never matches by document alone', () => {
    const noPosition = sourceRef.parse({ chunkId: 'f0932e68f724', document: '377252' });
    expect(
      sameSource(noPosition, { chunkId: '9c1d0b7e2a44', document: '377252', position: 437 }),
    ).toBe(false);
  });
});
