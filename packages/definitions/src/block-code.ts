import { fieldOf } from '@genai/contracts/block-fields';
import { z } from 'zod';
import type { PromptFiles } from './prompts.js';
import type { ValidationError } from './validate.js';

export const blockFilePaths = { bundle: 'block/bundle.js', sourcePrefix: 'block/source/' } as const;

export const blockCodeLimits = {
  bundleBytes: 256 * 1024,
  sourceFiles: 20,
  sourceBytes: 512 * 1024,
  reads: 32,
} as const;

export const blockCode = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'must be 64 lowercase hex digits'),
  bytes: z.number().int().positive().max(blockCodeLimits.bundleBytes),
  reads: z.array(z.string().max(160)).max(blockCodeLimits.reads).default([]),
  height: z.number().int().min(40).max(2_000).optional(),
});

export type BlockCode = z.output<typeof blockCode>;

export const isBlockFile = (name: string) => name.startsWith('block/');

const sourcePath =
  /^block\/source\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}(\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}){0,4}$/;

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

/** The checks on a code block that need neither its files nor the platform's settings. */
export const checkBlockCode = (spec: { code?: BlockCode | undefined }): ValidationError[] =>
  (spec.code?.reads ?? []).flatMap((path, i) =>
    fieldOf(path)
      ? []
      : [{ path: `spec.code.reads[${i}]`, message: `${path} is not a field a block can read` }],
  );

const codeFileProblems = (code: BlockCode | undefined, files: PromptFiles): ValidationError[] => {
  const errors: ValidationError[] = [];
  const sources = Object.keys(files).filter((name) => name.startsWith(blockFilePaths.sourcePrefix));
  for (const name of Object.keys(files).filter(isBlockFile)) {
    if (name === blockFilePaths.bundle) continue;
    if (!sourcePath.test(name) || name.includes('..'))
      errors.push({
        path: `files.${name}`,
        message: 'a code block carries only block/bundle.js and block/source/<path>',
      });
  }
  const bundle = files[blockFilePaths.bundle];
  if (bundle === undefined)
    errors.push({
      path: `files.${blockFilePaths.bundle}`,
      message: 'a code block needs its bundle',
    });
  else {
    const bytes = bytesOf(bundle);
    if (bytes > blockCodeLimits.bundleBytes)
      errors.push({
        path: `files.${blockFilePaths.bundle}`,
        message: `the bundle is ${bytes} bytes; at most ${blockCodeLimits.bundleBytes}`,
      });
    else if (code && bytes !== code.bytes)
      errors.push({
        path: 'spec.code.bytes',
        message: `the bundle is ${bytes} bytes, not ${code.bytes}`,
      });
    if (bundle.includes('\u0000'))
      errors.push({ path: `files.${blockFilePaths.bundle}`, message: 'the bundle holds a NUL' });
  }
  if (sources.length > blockCodeLimits.sourceFiles)
    errors.push({
      path: 'files',
      message: `at most ${blockCodeLimits.sourceFiles} source files; there are ${sources.length}`,
    });
  const sourceBytes = sources.reduce((sum, name) => sum + bytesOf(files[name] ?? ''), 0);
  if (sourceBytes > blockCodeLimits.sourceBytes)
    errors.push({
      path: 'files',
      message: `the source files are ${sourceBytes} bytes in all; at most ${blockCodeLimits.sourceBytes}`,
    });
  return errors;
};

export const checkBlockFiles = (
  spec: { tier: string; code?: BlockCode | undefined } | undefined,
  files: PromptFiles,
): ValidationError[] =>
  spec?.tier === 'code'
    ? codeFileProblems(spec.code, files)
    : Object.keys(files)
        .filter(isBlockFile)
        .map((name) => ({
          path: `files.${name}`,
          message: 'a file under block/ belongs only to a code block',
        }));

export interface CodeEditionContext {
  blockOrigin: string | undefined;
  /** The sha256 of `block/bundle.js`, computed by the caller since this package has no crypto. */
  bundleSha256: string | undefined;
}

/** The checks on a code block that need the platform: a block origin, and the bundle's hash. */
export const checkCodeEdition = (
  spec: { tier: string; code?: BlockCode | undefined },
  context: CodeEditionContext,
): ValidationError[] => {
  if (spec.tier !== 'code') return [];
  if (!context.blockOrigin)
    return [
      {
        path: 'spec.tier',
        message: 'code blocks are off on this platform until a block origin is set',
      },
    ];
  return spec.code &&
    context.bundleSha256 !== undefined &&
    context.bundleSha256 !== spec.code.sha256
    ? [{ path: 'spec.code.sha256', message: 'the bundle does not match its sha256' }]
    : [];
};
