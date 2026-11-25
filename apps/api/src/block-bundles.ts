import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { t } from './i18n/index.js';
import { createHash } from 'node:crypto';
import {
  blockFilePaths,
  checkCodeEdition,
  type BlockDefinition,
  type PromptFiles,
  type ValidationError,
} from '@genai/definitions';

export const sha256Of = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A code block's checks that need the platform: a block origin, and a bundle matching its hash. */
export const codeBlockProblems = (
  definition: unknown,
  files: PromptFiles,
  blockOrigin: string | undefined,
): ValidationError[] => {
  const d = definition as Partial<BlockDefinition> | undefined;
  if (d?.kind !== 'Block' || d.spec?.tier !== 'code') return [];
  const bundle = files[blockFilePaths.bundle];
  return checkCodeEdition(d.spec, {
    blockOrigin,
    bundleSha256: bundle === undefined ? undefined : sha256Of(bundle),
  });
};

export const maxDefinitionBodyBytes = 4 * 1024 * 1024;

export const definitionTooLargeType = 'urn:genai:problem:definition-too-large';

const tooLarge = (c: Context) =>
  c.json(
    {
      type: definitionTooLargeType,
      title: t('problems.status413'),
      status: 413,
      detail: t('problems.requestTooLarge', { limit: '4 MiB' }),
    },
    413,
    { 'content-type': 'application/problem+json' },
  );

const limitStream = bodyLimit({ maxSize: maxDefinitionBodyBytes, onError: tooLarge });

/** At most 4 MiB, also when a middleware before it has already read the body. */
export const definitionBodyLimit: MiddlewareHandler = async (c, next) => {
  if (c.req.raw.bodyUsed || c.req.raw.body?.locked) {
    const text = await c.req.text();
    if (Buffer.byteLength(text, 'utf8') > maxDefinitionBodyBytes) return tooLarge(c);
    return next();
  }
  return limitStream(c, next);
};
