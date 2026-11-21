import { z } from 'zod';
import type { ValidationError } from './validate.js';

export const blockTemplate = z.record(z.string(), z.unknown());

export type BlockTemplate = z.output<typeof blockTemplate>;

export const checkBlockTemplate = (_spec: {
  template?: BlockTemplate | undefined;
}): ValidationError[] => [
  {
    path: 'spec.tier',
    message:
      'declarative blocks are not drawn by any host yet; only built-in blocks can be published',
  },
];

/** The canonical field paths a template reads. */
export const templateReads = (_template: BlockTemplate | undefined): string[] => [];
