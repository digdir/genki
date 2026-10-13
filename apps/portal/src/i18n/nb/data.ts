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
} as const;
