import { assistantUi } from './build-assistantUi';
import type { Translation } from '@genai/i18n';
import type { build as source } from '../nb/build';
import { servicesUi } from './build-servicesUi';
import { setupUi } from './build-setupUi';
import { serviceUi } from './build-serviceUi';
import { stepflowsUi } from './build-stepflowsUi';
import { batchUi } from './build-batchUi';
import { playgroundUi } from './build-playgroundUi';
import { blocksUi } from './build-blocksUi';

export const build = {
  ...servicesUi,
  ...setupUi,
  ...serviceUi,
  ...stepflowsUi,
  ...batchUi,
  ...playgroundUi,
  ...assistantUi,
  ...blocksUi,
} satisfies Translation<typeof source>;
