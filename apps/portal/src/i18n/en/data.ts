import type { Translation } from '@genai/i18n';
import type { data as source } from '../nb/data';
import { connectorsLane } from './connectors';
import { blocksLane } from './data-blocks';
import { configLane } from './data-config';
import { datasetsLane } from './data-datasets';
import { skillsLane } from './data-skills';

export const data = {
  ...blocksLane,
  ...skillsLane,
  ...connectorsLane,
  ...configLane,
  ...datasetsLane,
} satisfies Translation<typeof source>;
