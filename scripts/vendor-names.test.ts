import { describe, expect, it } from 'vitest';
import {
  knownViolations,
  scanVendorNames,
  vendorIdentifiers,
  vendorViolations,
} from './vendor-names.ts';

describe('vendor names', () => {
  it('stay out of identifiers outside the provider packages and composition roots', () => {
    expect(vendorViolations().map((v) => `${v.file}:${v.line} ${v.name}`)).toEqual([]);
  }, 30_000);

  it('keep the list of known violations honest', () => {
    const found = scanVendorNames();
    for (const [file, names] of Object.entries(knownViolations))
      for (const name of names)
        expect(
          found.some((v) => v.file === file && v.name === name),
          `${file} no longer uses ${name}; remove it from knownViolations`,
        ).toBe(true);
  });

  it('flag code names but allow vendor names as config keys, strings and provider imports', () => {
    const source = [
      "import { typesense } from '@genai/providers-typesense';",
      'const colbertClient = 1;',
      'const exposure = { openai: true };',
      'const on = exposure.openai;',
      "const label = 'Azure OpenAI';",
      'interface Keys { langfuse: string }',
      'function readFromAnthropic() {}',
    ].join('\n');
    expect(vendorIdentifiers('x.ts', source).map((v) => v.name)).toEqual([
      'colbertClient',
      'readFromAnthropic',
    ]);
  });
});
