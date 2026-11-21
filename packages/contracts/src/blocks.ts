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
