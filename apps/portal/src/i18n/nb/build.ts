import { assistantUi } from './build-assistantUi';
import { servicesUi } from './build-servicesUi';
import { setupUi } from './build-setupUi';
import { serviceUi } from './build-serviceUi';
import { stepflowsUi } from './build-stepflowsUi';
import { batchUi } from './build-batchUi';
import { playgroundUi } from './build-playgroundUi';

export const build = {
  ...servicesUi,
  ...setupUi,
  ...serviceUi,
  ...stepflowsUi,
  ...batchUi,
  ...playgroundUi,
  ...assistantUi,
} as const;
