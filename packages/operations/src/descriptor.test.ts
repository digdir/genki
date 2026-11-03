import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideShape, embedShape } from '@genai/kernel';
import { parseDescriptor } from './descriptor.js';
import { evaluate } from './mapping.js';
import { bundledDescriptorDir, loadDescriptors } from './registry.js';

const embedYaml = readFileSync(join(bundledDescriptorDir, 'openai', 'embed@1.yaml'), 'utf8');

const refused = (yaml: string) => {
  try {
    parseDescriptor(yaml);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

describe('operation descriptors', () => {
  it('a typed descriptor declares the same shapes as the operation it serves', () => {
    const registry = loadDescriptors();
    expect(registry.get('openai/embed@1')?.input).toEqual(embedShape.request);
    expect(registry.get('openai/embed@1')?.output).toEqual(embedShape.result);
    expect(registry.get('openai/decide@1')?.input).toEqual(decideShape.request);
    expect(registry.get('openai/decide@1')?.output).toEqual(decideShape.result);
    expect(refused(embedYaml.replace('input: [text]', 'input: [plain]'))).toMatch(
      /declares the input and output shapes of embed/,
    );
  });

  it('a descriptor that names a URL is refused', () => {
    expect(
      refused(embedYaml.replace('encoding_format: float', 'encoding_format: https://evil.example')),
    ).toMatch(/names no URL/);
  });

  it('a descriptor for an API kept out of descriptors is refused', () => {
    for (const path of ['/files', '/batches', '/realtime/sessions', '/responses/{deployment}'])
      expect(refused(embedYaml.replace('path: /embeddings', `path: ${path}`))).toMatch(
        /kept out|may only hold/,
      );
    expect(
      refused(
        embedYaml.replace('      encoding_format: { enum: [float] }', '      store: boolean'),
      ),
    ).toMatch(/may not carry store/);
  });

  it('a descriptor that sets a credential header is refused', () => {
    expect(
      refused(embedYaml.replace('  version: v1', '  version: v1\n  headers:\n    api-key: abc')),
    ).toMatch(/credentials come from the endpoint/);
  });

  it('a descriptor mapping reads only what it is given', () => {
    expect(refused(embedYaml.replace('input: $input', 'input: $secrets.key'))).toMatch(
      /reads \$secrets/,
    );
  });

  it('a mapping copies, defaults, omits and orders without code', () => {
    const scope = {
      response: {
        data: [
          { index: 1, v: 'b' },
          { index: 0, v: 'a' },
        ],
        n: 0,
      },
    };
    expect(
      evaluate(
        {
          list: { $each: '$response.data', $sort: 'index', $map: '$item.v' },
          missing: { $from: '$response.none', $default: 5 },
          zero: { $from: '$response.n', $omitWhen: [0] },
          fixed: 'float',
          dollar: { $literal: '$response' },
        },
        scope,
      ),
    ).toEqual({ list: ['a', 'b'], missing: 5, fixed: 'float', dollar: '$response' });
  });
});
