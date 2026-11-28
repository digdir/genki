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
    .map((file) => [file.replaceAll('\\', '/'), fs.readFileSync(new URL(file, here), 'utf8')]);
});

describe('spinners in the console', () => {
  it('shows a spinner only inside a clicked button', () => {
    expect(sources.length).toBeGreaterThan(80);
    const spinning = sources
      .filter(([, text]) => /<Spinner\b|ds-spinner/.test(text))
      .map(([file]) => file);
    expect(spinning).toEqual([]);
  });
});
