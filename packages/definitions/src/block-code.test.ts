import { describe, expect, it } from 'vitest';
import {
  blockDefinition,
  checkBlockFiles,
  checkCodeEdition,
  validateDefinition,
  type PluginSchemas,
} from './index.js';

const plugins: PluginSchemas = {
  strategies: new Map(),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  models: new Map(),
};

const bundle = "genki.onRender(function () { document.body.textContent = 'Figur'; });";
const bytes = new TextEncoder().encode(bundle).length;
const sha = 'a'.repeat(64);

const codeBlock = (code: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant: '991825827', id: 'figur' },
  spec: {
    tier: 'code',
    title: { nb: 'Figur' },
    zones: ['main'],
    code: { sha256: sha, bytes, reads: ['question.text', 'sources.title'], ...code },
  },
});

const spec = (code: Record<string, unknown> = {}) => blockDefinition.parse(codeBlock(code)).spec;

const origin = 'https://blocks.example.test';

describe('a code block', () => {
  it('refuses a code block whose bundle does not match its sha256', () => {
    expect(checkCodeEdition(spec(), { blockOrigin: origin, bundleSha256: 'b'.repeat(64) })).toEqual(
      [{ path: 'spec.code.sha256', message: 'the bundle does not match its sha256' }],
    );
    expect(checkCodeEdition(spec(), { blockOrigin: origin, bundleSha256: sha })).toEqual([]);
  });

  it('refuses a code block while no block origin is set', () => {
    expect(checkCodeEdition(spec(), { blockOrigin: undefined, bundleSha256: sha })).toEqual([
      {
        path: 'spec.tier',
        message: 'code blocks are off on this platform until a block origin is set',
      },
    ]);
  });

  it('refuses a bundle over 256 KiB', () => {
    const big = 'x'.repeat(256 * 1024 + 1);

    expect(checkBlockFiles(spec(), { 'block/bundle.js': big })).toEqual([
      {
        path: 'files.block/bundle.js',
        message: `the bundle is ${big.length} bytes; at most 262144`,
      },
    ]);
    expect(validateDefinition(codeBlock({ bytes: 256 * 1024 + 1 }), plugins).ok).toBe(false);
  });

  it('counts the bundle in UTF-8 bytes and holds it to the size it states', () => {
    expect(checkBlockFiles(spec({ bytes: 3 }), { 'block/bundle.js': 'æø' })).toEqual([
      { path: 'spec.code.bytes', message: 'the bundle is 4 bytes, not 3' },
    ]);
  });

  it('refuses a bundle with a NUL in it', () => {
    expect(checkBlockFiles(spec({ bytes: 3 }), { 'block/bundle.js': 'a\u0000b' })).toEqual([
      { path: 'files.block/bundle.js', message: 'the bundle holds a NUL' },
    ]);
  });

  it('refuses a code block without its bundle', () => {
    expect(checkBlockFiles(spec(), {})).toEqual([
      { path: 'files.block/bundle.js', message: 'a code block needs its bundle' },
    ]);
  });

  it('refuses source files over 512 KiB in all or more than 20', () => {
    const many = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`block/source/f${i}.ts`, 'x']),
    );
    const heavy = {
      'block/source/a.ts': 'x'.repeat(300 * 1024),
      'block/source/b.ts': 'x'.repeat(300 * 1024),
    };

    expect(checkBlockFiles(spec(), { 'block/bundle.js': bundle, ...many })).toEqual([
      { path: 'files', message: 'at most 20 source files; there are 21' },
    ]);
    expect(checkBlockFiles(spec(), { 'block/bundle.js': bundle, ...heavy })).toEqual([
      { path: 'files', message: `the source files are ${600 * 1024} bytes in all; at most 524288` },
    ]);
    expect(
      checkBlockFiles(spec(), { 'block/bundle.js': bundle, 'block/source/src/Figur.tsx': 'x' }),
    ).toEqual([]);
  });

  it('refuses a file other than block/bundle.js and block/source/*', () => {
    const paths = [
      'block/index.html',
      'block/source/../bundle.js',
      'block/source/.hidden',
      'block/source/',
      'block/bundle.js.map',
    ];

    for (const path of paths)
      expect(checkBlockFiles(spec(), { 'block/bundle.js': bundle, [path]: 'x' })).toEqual([
        {
          path: `files.${path}`,
          message: 'a code block carries only block/bundle.js and block/source/<path>',
        },
      ]);
  });

  it('checks a source path in linear time', () => {
    const hostile = `block/source/${'a'.repeat(50_000)}!`;
    const started = performance.now();

    checkBlockFiles(spec(), { 'block/bundle.js': bundle, [hostile]: 'x' });

    expect(performance.now() - started).toBeLessThan(100);
  });

  it('refuses a read outside the field list', () => {
    const result = validateDefinition(
      codeBlock({ reads: ['question.text', 'person.ssn'] }),
      plugins,
    );

    expect(result.ok ? [] : result.errors).toEqual([
      { path: 'spec.code.reads[1]', message: 'person.ssn is not a field a block can read' },
    ]);
  });

  it('refuses more than 32 reads', () => {
    const reads = Array.from({ length: 33 }, () => 'question.text');

    expect(validateDefinition(codeBlock({ reads }), plugins).ok).toBe(false);
  });

  it('accepts a code block whose reads are in the field list', () => {
    expect(validateDefinition(codeBlock(), plugins).ok).toBe(true);
  });
});
