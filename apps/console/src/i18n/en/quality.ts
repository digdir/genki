import type { Translation } from '@genai/i18n';
import type { quality as source } from '../nb/quality';

export const quality = {
  title: 'Quality',
  loading: 'Loading quality data',
  metric: '{mean} ({low} to {high}, n={n})',
  dropped: 'Services that dropped',
  perService: 'Quality per service',
  colServiceShort: 'Service',
  colTenant: 'Organisation',
  colNow: 'Now',
  colTwoWeeksAgo: 'Two weeks ago',
  colChange: 'Change',
  shared: 'Shared service',
  up: 'up {delta}',
  down: 'down {delta}',
  judges: 'Automatic evaluation',
  emptyTitle: 'No evaluations yet',
  emptyText: 'When a service is evaluated, the result appears here.',
  latestRuns: 'Latest runs',
  colTestSet: 'Test set',
  colResult: 'Result',
  colStatus: 'Status',
  colRan: 'Ran',
  regressionIn: 'Regression: {metrics}',
  noRegression: 'No regression',
} satisfies Translation<typeof source>;
