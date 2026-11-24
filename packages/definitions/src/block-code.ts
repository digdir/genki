import { z } from 'zod';
import type { PromptFiles } from './prompts.js';
import type { ValidationError } from './validate.js';

export const blockFilePaths = { bundle: 'block/bundle.js', sourcePrefix: 'block/source/' } as const;

export const blockCode = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'must be 64 lowercase hex digits'),
  bytes: z.number().int().positive(),
  reads: z.array(z.string().max(160)).max(32).default([]),
  height: z.number().int().min(40).max(2_000).optional(),
});

export type BlockCode = z.output<typeof blockCode>;

export const isBlockFile = (name: string) => name.startsWith('block/');

export const checkBlockCode = (_spec: { code?: BlockCode | undefined }): ValidationError[] => [
  {
    path: 'spec.tier',
    message: 'code blocks are not drawn by any host yet; only built-in blocks can be published',
  },
];

export const checkBlockFiles = (
  spec: { tier: string } | undefined,
  files: PromptFiles,
): ValidationError[] =>
  Object.keys(files)
    .filter(isBlockFile)
    .flatMap((name) =>
      spec?.tier === 'code'
        ? []
        : [{ path: `files.${name}`, message: 'a file under block/ belongs only to a code block' }],
    );
