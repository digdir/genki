import { describe, expect, it } from 'vitest';
import { componentsByBlock } from './components.js';

describe('the components the docs call built', () => {
  it('never claim that access lists from a source follow the document, since no code carries them', () => {
    const built = Object.values(componentsByBlock)
      .flat()
      .filter((c) => c.status === 'bygd');
    const text = built.flatMap((c) => [c.description, ...c.capabilities]).join('\n');
    expect(text).not.toMatch(/ACL|tilgangsmetadata|tilgangsinformasjon fra kilden/i);
  });
});
