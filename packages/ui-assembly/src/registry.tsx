import {
  blockIds,
  blockSpec,
  blocksAllowedIn,
  isBlockId,
  nameKey,
  type AssistantLayout,
  type BlockId,
  type BuilderKey,
  type PlacedBlock,
  type Zone,
} from '@genai/ui-blocks';
import { isRefBlockId, type RefBlockPayload } from '@genai/contracts/blocks';
import { ChatIcon, FileSearchIcon, FileTextIcon, RobotIcon } from '@navikt/aksel-icons';
import type { ReactNode } from 'react';

/** A block this host draws with a component of its own: the built-in tier of ADR 0067. */
export interface BuiltInBlock {
  id: BlockId;
  label: BuilderKey;
  /** Its icon as a tool of the secondary panel, in the next look. */
  icon: ReactNode;
}

// The dev-verktoy boards' icons: Fremgangsmåte's robot, Kilder's page with a magnifier.
const toolIcons: Partial<Record<BlockId, ReactNode>> = {
  approach: <RobotIcon aria-hidden />,
  chat: <ChatIcon aria-hidden />,
  sources: <FileSearchIcon aria-hidden />,
  'document-view': <FileTextIcon aria-hidden />,
};

export const blockRegistry: ReadonlyMap<BlockId, BuiltInBlock> = new Map(
  blockIds
    .filter((id) => blockSpec(id).status === 'built')
    .map((id) => [
      id,
      { id, label: nameKey(id), icon: toolIcons[id] ?? <FileTextIcon aria-hidden /> },
    ]),
);

export type ResolvedBlock =
  | { kind: 'built-in'; block: BuiltInBlock; placed: PlacedBlock }
  | { kind: 'ref'; payload: RefBlockPayload; placed: PlacedBlock }
  | { kind: 'unavailable'; ref: string; placed: PlacedBlock };

export type RefBlocks = Readonly<Record<string, RefBlockPayload>>;

/** A layout entry as this host draws it: its built-in block, a ref block, a placeholder, or nothing. */
export const resolveBlock = (
  placed: PlacedBlock,
  blocks: RefBlocks = {},
): ResolvedBlock | undefined => {
  if (isRefBlockId(placed.block)) {
    const payload =
      placed.ref && Object.hasOwn(blocks, placed.ref) ? blocks[placed.ref] : undefined;
    if (payload) return { kind: 'ref', payload, placed };
    return placed.ref ? { kind: 'unavailable', ref: placed.ref, placed } : undefined;
  }
  const block = isBlockId(placed.block) ? blockRegistry.get(placed.block) : undefined;
  if (block) return { kind: 'built-in', block, placed };
  return placed.ref ? { kind: 'unavailable', ref: placed.ref, placed } : undefined;
};

/** The built-in blocks a zone may hold, in the catalogue's order for it. */
export const builtInOrder = (zone: Zone): BlockId[] =>
  blocksAllowedIn(zone).filter((id) => blockRegistry.has(id));

/** The refs in a zone this host cannot draw, in the layout's order. */
export const unavailableIn = (
  layout: AssistantLayout,
  zone: Zone,
  blocks: RefBlocks = {},
): string[] =>
  layout.zones[zone].flatMap((placed) => {
    const resolved = resolveBlock(placed, blocks);
    return resolved?.kind === 'unavailable' ? [resolved.ref] : [];
  });

/** The ref blocks the interface resolved in a zone, in the layout's order. */
export const refBlocksIn = (layout: AssistantLayout, zone: Zone, blocks: RefBlocks = {}) =>
  layout.zones[zone].flatMap((placed) => {
    const resolved = resolveBlock(placed, blocks);
    return resolved?.kind === 'ref' ? [{ payload: resolved.payload, placed }] : [];
  });
