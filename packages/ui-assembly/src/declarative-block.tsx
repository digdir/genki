import type { BlockData } from '@genai/contracts/block-fields';
import type { BlockState, RefBlockPayload } from '@genai/contracts/blocks';
import { BlockPlaceholder } from './block-placeholder.js';

export interface DeclarativeBlockProps {
  payload: RefBlockPayload;
  data: BlockData;
  state: BlockState;
  settings?: Record<string, boolean | string> | undefined;
  level?: 2 | 3 | undefined;
}

export const DeclarativeBlock = ({ payload, level }: DeclarativeBlockProps) => (
  <BlockPlaceholder blockRef={payload.ref} {...(level ? { level } : {})} />
);
