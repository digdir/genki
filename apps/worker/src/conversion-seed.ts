import {
  asDoclingDocument,
  doclingPages,
  doclingParts,
  NotDoclingDocument,
  readDoclingOutput,
} from '@genai/ingest';
import { knowledgeSeedQueue, queueWork, type QueueWork } from '@genai/jobs';
import type { NativeOutputEntry, NativeOutputStore, StoredNativeOutput } from '@genai/port-blob';
import {
  doclingPagesDerivation,
  doclingPartsDerivation,
  settingsHash,
  type ConversionUnit,
  type ConversionWaiter,
  type Derivation,
  type RecordTransaction,
  type StoredConversions,
} from '@genai/port-knowledge';

interface Derived {
  pages: string[];
  units?: ConversionUnit[];
  /** Its pages or units, to check against meta.json. */
  count: number;
}

/**
 * What a seed can store from a converter's output: its pages, or with a derivation named, its parts
 * (ADR 0055). An output that is not a `DoclingDocument` is stored as a parts refusal, so it is not
 * read again; any other error, and any output pages cannot be derived from, is skipped.
 */
const derivations: Record<
  string,
  { derivation: Derivation; derive(output: Uint8Array): Derived; refuses: boolean }
> = {
  docling: {
    derivation: doclingPagesDerivation,
    refuses: false,
    derive: (output) => {
      const pages = doclingPages(asDoclingDocument(JSON.parse(new TextDecoder().decode(output))));
      return { pages, count: pages.length };
    },
  },
  'docling:docling-parts': {
    derivation: doclingPartsDerivation,
    refuses: true,
    derive: (output) => {
      const { units } = doclingParts(readDoclingOutput(output));
      return { pages: [], units, count: units.length };
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

/** Why a listed output cannot be seeded, its refusal, or what it derives. */
const derivedOf = (
  entry: NativeOutputEntry,
  found: StoredNativeOutput | undefined,
  known: (typeof derivations)[string],
): Derived | { reason: string; refused?: boolean } => {
  if (!found) return { reason: 'its output or meta.json is missing' };
  const meta = found.meta as Partial<StoredNativeOutput['meta']> | null;
  if (!meta?.settings || typeof meta.settings !== 'object' || typeof meta.pages !== 'number')
    return { reason: 'its meta.json has no settings or pages' };
  if (settingsHash(meta.settings) !== entry.settingsHash)
    return { reason: 'its meta.json settings do not match its path' };
  let derived: Derived;
  try {
    derived = known.derive(found.output);
  } catch (error) {
    if (known.refuses && error instanceof NotDoclingDocument)
      return { reason: 'its output is not a DoclingDocument', refused: true };
    // A bug in the derivation is not the file's fault: skipped, so a later seed derives it again.
    // Its name only, as a parse error's message quotes the output.
    if (known.refuses)
      return { reason: `its parts could not be derived: ${(error as Error).name}` };
    return { reason: `its output could not be read: ${(error as Error).message}` };
  }
  if (derived.count !== found.meta.pages)
    return { reason: `it has ${derived.count} pages, its meta.json ${found.meta.pages}` };
  return derived;
};

/**
 * A seed batch (ADR 0042, issue 474): stores a conversion for each native output in Blob under the
 * batch's prefix, converter, version and settings that has none yet, as pages or, when the batch names
 * `docling-parts`, as parts (ADR 0055, issue 634), with no fetch and no converter call. A file
 * that cannot be read is skipped and logged, so its file is converted as any other; only an output
 * that is not a `DoclingDocument` is stored, as a parts refusal. An error of the Blob service fails the batch,
 * and its retry skips what it already stored.
 */
export const seedWork = (deps: SeedDeps): QueueWork =>
  queueWork(knowledgeSeedQueue, async (job) => {
    deps.bound?.();
    const { prefix, converter, version, settings } = job.data;
    const derivation = 'derivation' in job.data ? job.data.derivation : undefined;
    const known = derivations[derivation ? `${converter}:${derivation}` : converter];
    if (!known) throw new Error(`no derivation makes ${derivation ?? 'pages'} from ${converter}`);
    const entries = (await deps.outputs.files(prefix)).filter(
      (e) => e.converter === converter && e.version === version && e.settingsHash === settings,
    );
    const already = await deps.conversions.storedAmong(
      { converter, version, settingsHash: settings, derivation: known.derivation },
      entries.map((e) => e.sha256),
    );
    let seeded = 0;
    let skipped = 0;
    let refused = 0;
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
      const result = damaged ? { reason: damaged } : derivedOf(entry, found, known);
      if ('reason' in result && !result.refused) {
        skipped += 1;
        deps.log?.('a seed skipped a file', {
          prefix,
          sha256: entry.sha256,
          reason: result.reason,
        });
        continue;
      }
      const stored = {
        sha256: entry.sha256,
        converter,
        version,
        settings: (found as StoredNativeOutput).meta.settings,
        derivation: known.derivation,
        outputPath: entry.path,
      };
      if ('reason' in result) {
        refused += 1;
        deps.log?.('a seed stored a refusal', {
          prefix,
          sha256: entry.sha256,
          derivation: known.derivation.name,
          reason: result.reason,
        });
        await deps.conversions.store(
          { ...stored, pages: [], failure: 'conversion_failed' },
          deps.sendIndex,
        );
        continue;
      }
      await deps.conversions.store(
        {
          ...stored,
          pages: result.pages,
          ...(result.units ? { units: result.units } : {}),
        },
        deps.sendIndex,
      );
      seeded += 1;
    }
    deps.log?.('a seed batch ended', {
      prefix,
      derivation: known.derivation.name,
      seeded,
      skipped,
      refused,
      already: already.size,
    });
  }) as QueueWork;
