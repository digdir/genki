import { doclingPages, type DoclingDocument } from '@genai/ingest';
import { knowledgeSeedQueue, queueWork, type QueueWork } from '@genai/jobs';
import type { NativeOutputEntry, NativeOutputStore, StoredNativeOutput } from '@genai/port-blob';
import {
  doclingPagesDerivation,
  settingsHash,
  type ConversionWaiter,
  type Derivation,
  type RecordTransaction,
  type StoredConversions,
} from '@genai/port-knowledge';

/** The converters a seed can store, each with the derivation that makes its pages. */
const derivations: Record<string, { derivation: Derivation; pages(output: unknown): string[] }> = {
  docling: {
    derivation: doclingPagesDerivation,
    pages: (output) => {
      const document = output as Partial<DoclingDocument> & { schema_name?: unknown };
      if (
        document.schema_name !== 'DoclingDocument' ||
        !document.body ||
        !Array.isArray(document.texts) ||
        !document.pages
      )
        throw new Error('not a DoclingDocument');
      return doclingPages(document as DoclingDocument);
    },
  },
};

export interface SeedDeps {
  conversions: StoredConversions;
  outputs: Pick<NativeOutputStore, 'files' | 'read'>;
  /** Sends the index job of a record that waited on the stored conversion. */
  sendIndex(waiter: ConversionWaiter, transaction: RecordTransaction): Promise<unknown>;
  log?: (msg: string, fields: Record<string, unknown>) => void;
  /** Throws while the knowledge server is bound to another platform server (ADR 0042). */
  bound?: () => void;
}

/** Why a listed output cannot be seeded, or its pages. */
const pagesOf = (
  entry: NativeOutputEntry,
  found: StoredNativeOutput | undefined,
  derive: (output: unknown) => string[],
): { pages: string[] } | { reason: string } => {
  if (!found) return { reason: 'its output or meta.json is missing' };
  const meta = found.meta as Partial<StoredNativeOutput['meta']> | null;
  if (!meta?.settings || typeof meta.settings !== 'object' || typeof meta.pages !== 'number')
    return { reason: 'its meta.json has no settings or pages' };
  if (settingsHash(meta.settings) !== entry.settingsHash)
    return { reason: 'its meta.json settings do not match its path' };
  let pages: string[];
  try {
    pages = derive(JSON.parse(new TextDecoder().decode(found.output)));
  } catch (error) {
    return { reason: `its output could not be read: ${(error as Error).message}` };
  }
  if (pages.length !== found.meta.pages)
    return { reason: `it has ${pages.length} pages, its meta.json ${found.meta.pages}` };
  return { pages };
};

/**
 * A seed batch (ADR 0042, issue 474): stores a conversion for each native output in Blob under the
 * batch's prefix, converter, version and settings that has none yet. A file that cannot be read is
 * skipped and logged, never stored as a failure, so its file is converted as any other; an error
 * of the Blob service fails the batch, and its retry skips what it already stored.
 */
export const seedWork = (deps: SeedDeps): QueueWork =>
  queueWork(knowledgeSeedQueue, async (job) => {
    deps.bound?.();
    const { prefix, converter, version, settings } = job.data;
    const known = derivations[converter];
    if (!known) throw new Error(`no derivation makes pages from ${converter}`);
    const entries = (await deps.outputs.files(prefix)).filter(
      (e) => e.converter === converter && e.version === version && e.settingsHash === settings,
    );
    const already = await deps.conversions.storedAmong(
      { converter, version, settingsHash: settings, derivation: known.derivation },
      entries.map((e) => e.sha256),
    );
    let seeded = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (already.has(entry.sha256)) continue;
      job.signal.throwIfAborted();
      let found: StoredNativeOutput | undefined;
      let damaged: string | undefined;
      try {
        found = await deps.outputs.read(entry);
      } catch (error) {
        // A damaged gzip or meta.json is the file's fault; anything else is the Blob service's, so retried.
        const fileFault =
          error instanceof SyntaxError ||
          String((error as { code?: unknown }).code).startsWith('Z_');
        if (!fileFault) throw error;
        damaged = `its output or meta.json is damaged: ${(error as Error).message}`;
      }
      const result = damaged ? { reason: damaged } : pagesOf(entry, found, known.pages);
      if ('reason' in result) {
        skipped += 1;
        deps.log?.('a seed skipped a file', {
          prefix,
          sha256: entry.sha256,
          reason: result.reason,
        });
        continue;
      }
      await deps.conversions.store(
        {
          sha256: entry.sha256,
          converter,
          version,
          settings: (found as StoredNativeOutput).meta.settings,
          derivation: known.derivation,
          pages: result.pages,
          outputPath: entry.path,
        },
        deps.sendIndex,
      );
      seeded += 1;
    }
    deps.log?.('a seed batch ended', { prefix, seeded, skipped, already: already.size });
  }) as QueueWork;
