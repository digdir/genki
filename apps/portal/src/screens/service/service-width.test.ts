import { beforeAll, describe, expect, it } from 'vitest';

let service = '';
let app = '';
let services = '';
let stepflows = '';
beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as {
    readFileSync: (path: URL, encoding: 'utf8') => string;
  };
  service = fs.readFileSync(new URL('./service.css', import.meta.url), 'utf8');
  app = fs.readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
  services = fs.readFileSync(new URL('../services.css', import.meta.url), 'utf8');
  stepflows = fs.readFileSync(new URL('../stepflows.css', import.meta.url), 'utf8');
});

const rule = (css: string, selector: string) =>
  css
    .split('}')
    .map((block) => block.split('{'))
    .find(([head]) => head?.trim() === selector)?.[1];

const maxWidth = (css: string, selector: string) =>
  rule(css, selector)?.match(/max-width:\s*([^;]+);/)?.[1];

const pageWide = (css: string) =>
  [...css.matchAll(/max-width:\s*(\d+)px/g)].filter(([, px]) => Number(px) > 1000);

describe('the width of the page', () => {
  it('gives every service tab the width of the page column that Grensesnitt fills', () => {
    expect(maxWidth(service, '.service-body')).toBe(maxWidth(app, '.main-inner'));
  });

  it('stops the page column at 1920 px and keeps it against the menu', () => {
    expect(maxWidth(app, '.main-inner')).toBe('var(--page-max)');
    expect(rule(app, '.main-inner')).toContain('margin: 0;');
    expect(app).toContain('--page-max: 1920px;');
  });

  it('pads the page 32 px, 48 px from 1600 px and 16 px under 640 px', () => {
    expect(app).toContain('--page-pad: 32px;');
    expect(app).toMatch(/@media \(min-width: 1600px\) \{\s*:root \{\s*--page-pad: 48px;/);
    expect(app).toMatch(/@media \(max-width: 639px\) \{\s*:root \{\s*--page-pad: 16px;/);
    expect(rule(app, '.main')).toContain('var(--page-pad)');
  });

  it('caps only reading text near 70 characters', () => {
    expect(app).toContain('--read-max: 70ch;');
    expect(maxWidth(app, '.prose,\n.main-inner > p,\n.main-inner > .ds-paragraph')).toBe(
      'var(--read-max)',
    );
  });

  it('lets no service tab, list or step flow page stop narrower than the page column', () => {
    expect(pageWide(service)).toEqual([]);
    expect(maxWidth(services, '.services-page')).toBeUndefined();
    expect(maxWidth(stepflows, '.stepflows')).toBeUndefined();
  });

  it('keeps dialogs at 560 px and side panels at 480 px', () => {
    expect(app).toContain('--dialog-width: 560px;');
    expect(app).toContain('--panel-width: 480px;');
    expect(rule(app, ':root .ds-dialog')).toContain('--dsc-dialog-max-width: var(--dialog-width);');
  });
});
