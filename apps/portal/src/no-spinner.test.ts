import { beforeAll, describe, expect, it } from 'vitest';

let sources: [string, string][] = [];
beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as {
    readFileSync: (path: URL, encoding: 'utf8') => string;
    readdirSync: (path: URL, options: { recursive: true }) => string[];
  };
  const here = new URL('./', import.meta.url);
  sources = fs
    .readdirSync(here, { recursive: true })
    .filter((file) => file.endsWith('.tsx') && !file.includes('.test.'))
    .map((file) => [file, fs.readFileSync(new URL(file, here), 'utf8')]);
});

const awaitingOtherLanes = new Set([
  'screens/datasets/LiveDatasetDetail.tsx',
  'screens/services/blocks/TryViewKeeper.tsx',
]);

describe('spinners in the portal', () => {
  it('shows a spinner only inside a button after a click, through BusyButton', () => {
    expect(sources.length).toBeGreaterThan(100);
    const spinning = sources
      .filter(([, text]) => /<Spinner\b|ds-spinner/.test(text))
      .map(([file]) => file.replaceAll('\\', '/'))
      .filter((file) => !awaitingOtherLanes.has(file));
    expect(spinning).toEqual([]);
  });
});
