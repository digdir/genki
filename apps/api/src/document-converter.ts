import { readFileSync } from 'node:fs';
import {
  byExtension,
  loadPhraseArchive,
  markerConverter,
  type DeclaredPhraseArchive,
  type DocumentConverter,
} from '@genai/ingest';
import { credentialFor, type SecretResolver } from '@genai/kernel';
import { createLocalConverter } from '@genai/providers-documents';

const delaysFrom = (raw: string | undefined) => {
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((d) => typeof d === 'number' && d >= 0))
    throw new Error('MARKER_RETRY_DELAYS_MS is a JSON list of milliseconds, such as [1000]');
  return parsed as number[];
};

const timeoutFrom = (raw: string | undefined) => {
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('MARKER_TIMEOUT_MS is a positive number');
  return ms;
};

export const documentConverterFrom = (
  env: Record<string, string | undefined>,
  secrets: SecretResolver,
): DocumentConverter | undefined => {
  const choice = env.DOCUMENT_CONVERTER ?? 'local';
  if (choice === 'none') return undefined;
  if (choice === 'local') return createLocalConverter();
  if (choice === 'marker') {
    if (!env.MARKER_URL) throw new Error('DOCUMENT_CONVERTER=marker needs MARKER_URL');
    const retryDelaysMs = delaysFrom(env.MARKER_RETRY_DELAYS_MS);
    const timeoutMs = timeoutFrom(env.MARKER_TIMEOUT_MS);
    const local = createLocalConverter();
    return byExtension([
      {
        converter: markerConverter({
          url: env.MARKER_URL,
          credential: credentialFor(
            { kind: 'api-key', secret: 'secret://env/marker-api-key' },
            secrets,
          ),
          ...(retryDelaysMs ? { retryDelaysMs } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        }),
        extensions: ['.pdf'],
      },
      {
        converter: local,
        extensions: (local.extensions ?? ['.docx']).filter((e) => e !== '.pdf'),
      },
    ]);
  }
  throw new Error(`DOCUMENT_CONVERTER is local, marker or none, not ${choice}`);
};

export const phraseArchiveFrom = (
  env: Record<string, string | undefined>,
  log: (message: string, data: Record<string, unknown>) => void = (message, data) =>
    console.info(message, data),
): DeclaredPhraseArchive | undefined => {
  const path = env.PHRASE_CACHE_ARCHIVE;
  if (!path) return undefined;
  const identity = env.PHRASE_CACHE_IDENTITY ?? path.replace(/\.edn\.gz$/, '.identity.edn');
  let loaded;
  try {
    loaded = loadPhraseArchive(readFileSync(path), readFileSync(identity, 'utf8'));
  } catch (error) {
    loaded = {
      action: 'skipped' as const,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  log('warm phrase cache', {
    action: loaded.action,
    ...(loaded.action === 'loaded'
      ? { entries: loaded.entries, verified: loaded.verified }
      : { reason: loaded.reason }),
  });
  return loaded.action === 'loaded' ? loaded.archive : undefined;
};
