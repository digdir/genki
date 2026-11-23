import type { BlockData } from '@genai/contracts/block-fields';
import type { BlockState, RefBlockPayload } from '@genai/contracts/blocks';
import { pickReads } from './block-data.js';
import { CodeBlock } from './code-block.js';
import { DeclarativeBlock } from './declarative-block.js';

export interface RefBlockProps {
  payload: RefBlockPayload;
  data: BlockData;
  state: BlockState;
  settings?: Record<string, boolean | string> | undefined;
  level?: 2 | 3 | undefined;
}

/** A declarative or code block, given only the fields it reads. */
export const RefBlock = ({ payload, data, ...rest }: RefBlockProps) => {
  const given = pickReads(data, payload.reads);
  return payload.tier === 'code' ? (
    <CodeBlock payload={payload} data={given} {...rest} />
  ) : (
    <DeclarativeBlock payload={payload} data={given} {...rest} />
  );
};
