import { beforeAll, describe, expect, it } from 'vitest';

let service = '';
let app = '';
beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as {
    readFileSync: (path: URL, encoding: 'utf8') => string;
  };
  service = fs.readFileSync(new URL('./service.css', import.meta.url), 'utf8');
  app = fs.readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
});

const maxWidth = (css: string, selector: string) =>
  css
    .split('}')
    .map((block) => block.split('{'))
    .find(([head]) => head?.trim() === selector)?.[1]
    ?.match(/max-width:\s*([^;]+);/)?.[1];

describe('the width of the service tabs', () => {
  it('gives every tab the width of the page column that Grensesnitt fills', () => {
    expect(maxWidth(service, '.service-body')).toBe(maxWidth(app, '.main-inner'));
  });
});
