import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADR_BASE, adrUrl, blocks } from './index.js';

const adrDir = new URL('../../../docs/adr/', import.meta.url);

describe('ADR links', () => {
  it('point every linked ADR at a file that exists in docs/adr', () => {
    const files = new Set(readdirSync(adrDir));
    const linked = blocks.flatMap((b) => b.adrs);
    expect(linked.length).toBeGreaterThan(0);
    for (const adr of linked) {
      const url = adrUrl(adr);
      expect(url.startsWith(ADR_BASE), `${adr.id} has no file`).toBe(true);
      expect(files.has(url.slice(ADR_BASE.length)), url).toBe(true);
    }
  });
});
