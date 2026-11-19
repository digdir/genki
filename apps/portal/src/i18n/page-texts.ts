import { addTexts } from '.';
import { setupUi as enSetupUi } from './en/build-setupUi';
import { assistantUi as enAssistantUi } from './en/build-assistantUi';
import { servicesUi as enServicesUi } from './en/build-servicesUi';
import { datasetsLane as enDatasetsLane } from './en/data-datasets';
import { logArea as enLogArea } from './en/operate-log';
import { statusArea as enStatusArea } from './en/operate-status';
import { usageArea as enUsageArea } from './en/operate-usage';
import { assistantUi } from './nb/build-assistantUi';
import { servicesUi } from './nb/build-servicesUi';
import { setupUi } from './nb/build-setupUi';
import { datasetsLane } from './nb/data-datasets';
import { logArea } from './nb/operate-log';
import { statusArea } from './nb/operate-status';
import { usageArea } from './nb/operate-usage';

export const pageParts = [
  'servicesUi',
  'setupUi',
  'assistantUi',
  'datasetsLane',
  'logArea',
  'usageArea',
  'statusArea',
] as const;

addTexts(
  {
    ...servicesUi,
    ...setupUi,
    ...assistantUi,
    ...datasetsLane,
    ...logArea,
    ...usageArea,
    ...statusArea,
  },
  {
    ...enServicesUi,
    ...enSetupUi,
    ...enAssistantUi,
    ...enDatasetsLane,
    ...enLogArea,
    ...enUsageArea,
    ...enStatusArea,
  },
);
