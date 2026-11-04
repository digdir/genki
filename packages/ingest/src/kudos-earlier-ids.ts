import type { KudosDocument } from './kudos.js';
import bundledMap from './kudos-earlier-ids.json' with { type: 'json' };

/**
 * The numeric ids of today's Kudos index and the KUDOS UUIDs they lead to (ADR 0042, "Identity and
 * chunks"). Written by `packages/eval/src/scripts/kudos-earlier-ids.ts`.
 */
export interface EarlierIdsMap {
  /** Numeric id to UUID. */
  ids: Record<string, string>;
  /** Numeric id to why it has no UUID. */
  unresolved: Record<string, string>;
}

export type EarlierIdCheck = { uuid: string } | { reason: string };

/**
 * Today's index was filled from KUDOS's test copy, so an old id that redirects on the live site is
 * kept only when one of its files has the same sha256 there: a title often differs only by the
 * ministry's name, while a renumbered id would lead to other files.
 */
export const checkEarlierId = (
  old: { sha256: string[] },
  live: Pick<KudosDocument, 'uuid' | 'files'>,
): EarlierIdCheck => {
  if (old.sha256.length === 0) return { reason: "no file sha256 in today's index" };
  const liveHashes = new Set((live.files ?? []).flatMap((f) => (f.sha256 ? [f.sha256] : [])));
  return old.sha256.some((h) => liveHashes.has(h)) && live.uuid
    ? { uuid: live.uuid }
    : { reason: `no file sha256 in common with ${live.uuid}` };
};

/** Each document's earlier ids, under its `kudos:` id, in numeric order. */
export const earlierIdsByDocument = (map: EarlierIdsMap) => {
  const byDocument = new Map<string, string[]>();
  for (const [id, uuid] of Object.entries(map.ids)) {
    const key = `kudos:${uuid}`;
    byDocument.set(key, [...(byDocument.get(key) ?? []), id]);
  }
  for (const ids of byDocument.values()) ids.sort((a, b) => Number(a) - Number(b));
  return byDocument;
};

let byDocument: Map<string, string[]> | undefined;

/** The earlier ids of today's Kudos index, by `kudos:` id, read once per process. */
export const kudosEarlierIds = (): ReadonlyMap<string, string[]> =>
  (byDocument ??= earlierIdsByDocument(bundledMap as EarlierIdsMap));
