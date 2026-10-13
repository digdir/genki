import type { Translation } from '@genai/i18n';
import type { quality as source } from '../nb/quality';

export const quality = {
  title: 'Quality',
  intro:
    'Scores on the test sets over time. Regressions after changes to a model or the platform are marked.',
  openMatrix: 'Open the quality matrix and the judges',
  loading: 'Loading quality data',
  metric: '{mean} ({low} to {high}, n={n})',
  regressions: { one: '{count} regression', other: '{count} regressions' },
  regressionsAfter: ' after {event}',
  regressionLine: '{name}: {from} → {to}. Now {now}.',
  showInChart: 'Show in the chart',
  chartLabel: 'Scores on test sets per week from {from} to {to}. Details in the table below.',
  perService: 'Quality per service',
  colService: 'Shared service or service',
  colServiceShort: 'Service',
  colNow: 'Now',
  colTwoWeeksAgo: 'Two weeks ago',
  colChange: 'Change',
  regression: 'Regression {delta}',
  note: 'Services are included only when the organisation has chosen to share its test set with Digdir. A regression means the score fell by 4 or more from one week to the next.',
  emptyTitle: 'No evaluations yet',
  emptyText: 'When a service is evaluated, the result is shown here.',
  latestRuns: 'Latest runs',
  colTestSet: 'Test set',
  colResult: 'Result',
  colStatus: 'Status',
  colRan: 'Ran',
  regressionIn: 'Regression: {metrics}',
  noRegression: 'No regression',
} satisfies Translation<typeof source>;
