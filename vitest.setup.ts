import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configure, getConfig } from '@testing-library/dom';
import { beforeEach, expect } from 'vitest';
import { quarantinedTests } from './scripts/quarantine-check.ts';

configure({ asyncUtilTimeout: 12_000 });

if (process.env.QUARANTINE !== 'off') {
  const quarantined = quarantinedTests(
    JSON.parse(readFileSync(join(import.meta.dirname, 'test', 'quarantine.json'), 'utf8')),
    new Date().toISOString().slice(0, 10),
  );
  if (quarantined.size > 0)
    beforeEach((context) => {
      if (quarantined.has(context.task.fullName)) context.skip();
    });
}

if (/[\\/]apps[\\/]portal[\\/]/.test(expect.getState().testPath ?? '')) {
  await (await import('./apps/portal/src/i18n/areas')).loadAllTexts();
  await import('@testing-library/react');
  const { asyncWrapper } = getConfig();
  const loading = () =>
    typeof document !== 'undefined' && document.querySelector('.screen-loading') !== null;
  const realTimeout = globalThis.setTimeout;
  const screenLoaded = async () => {
    const timersReal = () => globalThis.setTimeout === realTimeout;
    for (let waited = 0; loading() && timersReal() && waited < 12_000; waited += 20)
      await new Promise((resolve) => setTimeout(resolve, 20));
  };
  configure({
    asyncWrapper: (work) =>
      asyncWrapper(async () => {
        const result = await work();
        await screenLoaded();
        return result;
      }),
  });
}
