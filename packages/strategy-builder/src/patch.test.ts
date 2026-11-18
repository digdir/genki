import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyPatch, PatchError, sameJson } from './patch.js';
import type { JsonPatchOp } from './types.js';

const forbidden = ['__proto__', 'prototype', 'constructor'];
const escape = (segment: string) => segment.replace(/~/g, '~0').replace(/\//g, '~1');
const key = fc.constantFrom('a', 'b', 'items', '0', '1', '-', '', '~', '/', 'length');
const documentKey = fc.oneof(key, fc.string()).filter((k) => !forbidden.includes(k));
const { document } = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: 'small' },
    fc.jsonValue({ maxDepth: 0 }),
    tie('document'),
    fc.array(tie('node'), { maxLength: 3 }),
  ),
  document: fc.dictionary(documentKey, tie('node'), { maxKeys: 4, noNullPrototype: true }),
}));
const segment = fc.oneof(
  { arbitrary: key, weight: 2 },
  { arbitrary: fc.constantFrom(...forbidden), weight: 2 },
  { arbitrary: fc.string(), weight: 1 },
);
const pointer = fc
  .oneof(
    { arbitrary: fc.array(segment, { minLength: 1, maxLength: 3 }), weight: 4 },
    { arbitrary: fc.constant([]), weight: 1 },
  )
  .map((segments) => segments.map((s) => `/${escape(s)}`).join(''));
const path = fc.oneof({ arbitrary: pointer, weight: 9 }, { arbitrary: fc.string(), weight: 1 });
const value = fc.jsonValue({ maxDepth: 2 });
const op: fc.Arbitrary<JsonPatchOp> = fc.oneof(
  fc.record({ op: fc.constantFrom('add', 'replace', 'test'), path, value }),
  fc.record({ op: fc.constant('remove'), path }),
  fc.record({ op: fc.constantFrom('move', 'copy'), from: path, path }),
);

const plainThroughout = (value: unknown): boolean =>
  value === null || typeof value !== 'object'
    ? true
    : [Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value)) &&
      Object.values(value).every(plainThroughout);
const objectKeys = Object.getOwnPropertyNames(Object.prototype);
const arrayKeys = Object.getOwnPropertyNames(Array.prototype);

describe('applyPatch', () => {
  it('refuses a forbidden key at any position and leaves Object.prototype untouched', () => {
    const document = { config: { instructions: 'x' } };
    for (const path of ['/__proto__/polluted', '/config/constructor/prototype/polluted']) {
      expect(() => applyPatch(document, [{ op: 'add', path, value: true }])).toThrow(PatchError);
    }
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('refuses to write through a forbidden key at any position of the path', () => {
    const forbiddenPath = fc
      .tuple(
        fc.array(key, { maxLength: 2 }),
        fc.constantFrom(...forbidden),
        fc.array(key, { maxLength: 2 }),
      )
      .map(([head, bad, tail]) => [...head, bad, ...tail].map((s) => `/${escape(s)}`).join(''));
    const write: fc.Arbitrary<JsonPatchOp> = fc.oneof(
      fc.record({ op: fc.constantFrom('add', 'replace'), path: forbiddenPath, value }),
      fc.record({ op: fc.constant('remove'), path: forbiddenPath }),
      fc.record({
        op: fc.constantFrom('move', 'copy'),
        from: fc.constant('/a'),
        path: forbiddenPath,
      }),
    );
    fc.assert(
      fc.property(document, write, (doc, op) => {
        expect(() => applyPatch({ ...doc, a: {} }, [op])).toThrow(PatchError);
      }),
    );
  });

  it('either applies or throws a PatchError for any patch, without changing the input or any prototype', () => {
    fc.assert(
      fc.property(document, fc.array(op, { minLength: 1, maxLength: 3 }), (doc, ops) => {
        const before = structuredClone(doc);
        let result: unknown;
        try {
          result = applyPatch(doc, ops);
        } catch (error) {
          expect(error).toBeInstanceOf(PatchError);
        }
        expect(plainThroughout(result)).toBe(true);
        expect(doc).toEqual(before);
        expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(objectKeys);
        expect(Object.getOwnPropertyNames(Array.prototype)).toEqual(arrayKeys);
      }),
    );
  });

  it('adds, tests and removes a value at any new key, however its pointer is escaped', () => {
    fc.assert(
      fc.property(document, documentKey, value, (doc, name, added) => {
        fc.pre(!Object.hasOwn(doc, name));
        const path = `/${escape(name)}`;
        const ops: JsonPatchOp[] = [
          { op: 'add', path, value: added },
          { op: 'test', path, value: added },
          { op: 'remove', path },
        ];
        expect(sameJson(applyPatch(doc, ops), doc)).toBe(true);
      }),
    );
  });
});
