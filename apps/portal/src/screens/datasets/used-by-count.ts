import type { T } from '../../i18n';

export const usedByText = (t: T, count: number | undefined) =>
  count === undefined
    ? undefined
    : count === 0
      ? t('datasetUse.none')
      : t('datasetUse.services', { count });
