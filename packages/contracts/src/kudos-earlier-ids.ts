import bundledMap from './kudos-earlier-ids.json' with { type: 'json' };

/** Old Kudos index ids to KUDOS UUIDs (ADR 0042), written by eval's `kudos-earlier-ids` script. */
export interface EarlierIdsMap {
  /** Numeric id to UUID, by the live site's redirect and a file sha256 in common. */
  ids: Record<string, string>;
  /** Numeric id to UUID, by the one live document holding its file, for ids not redirected. */
  byFile?: Record<string, string>;
  /** Numeric id to why it has no UUID. */
  unresolved: Record<string, string>;
}

export const kudosEarlierIdsMap: EarlierIdsMap = bundledMap;
