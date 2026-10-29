import { describe, expect, it } from 'vitest';
import { applyPatch, PatchError } from './patch.js';

describe('applyPatch', () => {
  it('refuses a forbidden key at any position and leaves Object.prototype untouched', () => {
    const document = { config: { instructions: 'x' } };
    for (const path of ['/__proto__/polluted', '/config/constructor/prototype/polluted']) {
      expect(() => applyPatch(document, [{ op: 'add', path, value: true }])).toThrow(PatchError);
    }
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});
