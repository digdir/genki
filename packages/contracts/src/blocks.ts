export const builtInBlockIds = [
  'projects',
  'threads',
  'settings',
  'chat',
  'filter',
  'approach',
  'sources',
  'document-view',
  'notes',
] as const;

export type BuiltInBlockId = (typeof builtInBlockIds)[number];

export const isBuiltInBlockId = (value: unknown): value is BuiltInBlockId =>
  typeof value === 'string' && (builtInBlockIds as readonly string[]).includes(value);

/** The `block` of a placed block that pins a declarative or code Block by its `ref`. */
export const refBlockId = 'ref';

export const isRefBlockId = (value: unknown): value is typeof refBlockId => value === refBlockId;

export const blockTiers = ['built-in', 'declarative', 'code'] as const;
export const blockSharings = ['private', 'organisation', 'everyone'] as const;
export const blockZones = ['primary', 'main', 'secondary'] as const;
export const blockEvents = [
  'ask',
  'open-document',
  'set-filter',
  'open-page',
  'notify',
  'resize',
] as const;
export const blockStates = ['empty', 'loading', 'error', 'partial', 'disabled', 'filled'] as const;
export const blockLanguages = ['nb', 'nn', 'en'] as const;

export type BlockTier = (typeof blockTiers)[number];
export type BlockSharing = (typeof blockSharings)[number];
export type BlockZone = (typeof blockZones)[number];
export type BlockEvent = (typeof blockEvents)[number];
export type BlockState = (typeof blockStates)[number];
export type BlockLanguage = (typeof blockLanguages)[number];

export type LanguageMap = Partial<Record<BlockLanguage, string>>;

export interface BlockProps {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[] | undefined;
}

export type BlockTexts = Partial<Record<BlockLanguage, Record<string, string>>>;

/** What a host gets to draw one pinned declarative or code edition, keyed by its ref. */
export interface RefBlockPayload<Template = unknown> {
  ref: string;
  tier: 'declarative' | 'code';
  publisher: string;
  publisherName?: string | undefined;
  title: LanguageMap;
  summary?: LanguageMap | undefined;
  zones: BlockZone[];
  events: BlockEvent[];
  states: BlockState[];
  props?: BlockProps | undefined;
  texts?: BlockTexts | undefined;
  /** Canonical field paths, such as `sources.title`. */
  reads: string[];
  template?: Template | undefined;
  frame?: { url: string; sha256: string; height?: number | undefined } | undefined;
}

export type BlockOrigin = 'own' | 'built-in' | 'shared';

export interface BlockSummary {
  publisher: string;
  publisherName: string;
  id: string;
  tier: BlockTier;
  origin: BlockOrigin;
  title: LanguageMap;
  summary?: LanguageMap | undefined;
  zones: BlockZone[];
  sharing: BlockSharing;
  latest: { version: number; publishedAt: string };
  editions: number;
  usedBy: number;
}

export interface BlockEdition {
  version: number;
  publishedAt: string;
  publishedBy?: string | undefined;
  publishedByName?: string | undefined;
  reason: string;
  sharing: BlockSharing;
}

export interface BlockUse {
  service: string;
  name: string;
  draft?: number | undefined;
  test?: number | undefined;
  inUse?: number | undefined;
}

export interface BlockReview {
  status: 'pending' | 'approved' | 'declined';
  version: number;
  at: string;
  reason?: string | undefined;
}

export interface BlockDetail<Definition = Record<string, unknown>, Template = unknown> extends Omit<
  BlockSummary,
  'editions'
> {
  editions: BlockEdition[];
  edition: BlockEdition & { definition: Definition; render?: RefBlockPayload<Template> };
  usedIn: BlockUse[];
  review?: BlockReview | undefined;
}
