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

  it('a non-typed descriptor may not declare json in its request', () => {
    const review = embedYaml.replace('status: typed', 'status: review');
    expect(refused(review)).toBeUndefined();
    expect(
      refused(
        review.replace('      encoding_format: { enum: [float] }', '      encoding_format: json'),
      ),
    ).toMatch(/not typed may not declare json in its input or wire.request/);
    expect(
      refused(
        review
          .replace('input: [text]\n', 'input:\n  either: [[text], { object: { image: json } }]\n')
          .replace(
            '      input: [text]',
            '      input: { either: [[text], { object: { image: json } }] }',
          ),
      ),
    ).toMatch(/not typed may not declare json/);
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

  it('a descriptor whose input can choose the model is refused', () => {
    expect(refused(embedYaml.replace('model: $deployment', 'model: $input.model'))).toMatch(
      /request.body.model must be \$deployment/,
    );
    expect(
      refused(
        embedYaml
          .replace('status: typed', 'status: review')
          .replace(
            '      encoding_format: { enum: [float] }',
            '      encoding_format: { enum: [float] }\n      options?: { object: { deployment: plain } }',
          ),
      ),
    ).toMatch(/may name the model only at the top/);
    expect(
      refused(
        embedYaml.replace(
          '  body:\n    model: $deployment\n    input: $input\n    encoding_format: float',
          '  body: $input',
        ),
      ),
    ).toMatch(/request.body.model must be \$deployment/);
  });

  it('a descriptor id names its API, and the operation field names its kind', () => {
    const descriptor = parseDescriptor(
      embedYaml.replace('id: openai/embed@1', 'id: openai/embeddings@1'),
    );
    expect(descriptor).toMatchObject({ id: 'openai/embeddings@1', operation: 'embed' });
  });

  it("a stored descriptor that names an endpoint protocol is read with that protocol's family", () => {
    const stored = embedYaml.replace('family: openai', 'protocol: openai-embeddings');
    expect(parseDescriptor(stored).api.family).toBe('openai');
    expect(
      parseDescriptor(embedYaml.replace('family: openai', 'protocol: anthropic-messages')).api
        .family,
    ).toBe('anthropic');
  });

  it('a descriptor that declares stream events is refused until streaming is built', () => {
    expect(
      refused(
        embedYaml.replace(
          'stream: none',
          'stream:\n  events:\n    done:\n      shape: { object: { usage: plain } }\n      done: true',
        ),
      ),
    ).toMatch(/stream must be none/);
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
