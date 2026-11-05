import { randomUUID } from 'node:crypto';
import {
  defaultMediaOutputMaxBytes,
  mediaOutputPolicy,
  mediaOutputRules,
  type MediaOutput,
  type MediaOutputConfig,
} from '@genai/kernel';
import type { BlobStore } from '@genai/port-blob';

export const defaultMediaOutputTypes = 'image/*,audio/*,video/*,application/pdf,text/csv';

/** `GENAI_MEDIA_OUTPUT_TYPES` lists the allowed types with an optional cap each; `GENAI_MEDIA_OUTPUT_MAX_BYTES` is the default cap. */
export const mediaOutputConfigOf = (env: Record<string, string | undefined>): MediaOutputConfig => {
  const maxBytes = Number(env.GENAI_MEDIA_OUTPUT_MAX_BYTES ?? defaultMediaOutputMaxBytes);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0)
    throw new Error('GENAI_MEDIA_OUTPUT_MAX_BYTES must be a whole number of bytes');
  return {
    types: mediaOutputRules(env.GENAI_MEDIA_OUTPUT_TYPES ?? defaultMediaOutputTypes),
    maxBytes,
  };
};

export const mediaFolder = (task: string) => `runs/${task.replace(/[^A-Za-z0-9._-]/g, '-')}/media`;

export const blobMediaOutput = (config: MediaOutputConfig, blobs: BlobStore): MediaOutput =>
  mediaOutputPolicy(config, async (ctx, body, mediaType) => {
    const info = await blobs.put(
      { tenant: ctx.tenant, path: `${mediaFolder(ctx.task)}/${randomUUID()}` },
      body,
      mediaType,
    );
    return { tenant: info.tenant, path: info.path, sha256: info.sha256 };
  });
