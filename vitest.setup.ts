import { configure } from '@testing-library/dom';
import { expect } from 'vitest';

configure({ asyncUtilTimeout: 12_000 });

if (/[\\/]apps[\\/]portal[\\/]/.test(expect.getState().testPath ?? ''))
  await (await import('./apps/portal/src/i18n/areas')).loadAllTexts();
