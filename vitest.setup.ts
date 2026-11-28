import { configure, getConfig } from '@testing-library/dom';
import { expect } from 'vitest';

configure({ asyncUtilTimeout: 12_000 });

const app = /[\\/]apps[\\/](portal|console)[\\/]/.exec(expect.getState().testPath ?? '')?.[1];

if (app) {
  await (
    app === 'portal'
      ? await import('./apps/portal/src/i18n/areas')
      : await import('./apps/console/src/i18n/areas')
  ).loadAllTexts();
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
