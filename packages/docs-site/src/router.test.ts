import { describe, expect, it } from 'vitest';
import { configureRouting, href, parseHash, type Route } from './router';

const routes: Route[] = [
  { page: 'oversikt' },
  { page: 'malbilde' },
  { page: 'byggeklosser' },
  { page: 'byggeklosser', id: 'rag' },
  { page: 'byggeklosser', id: 'ki-infrastruktur', sub: 'sigma2' },
  { page: 'tjenester', id: 'kunnskapsassistenten', del: 'oppsett', steg: 2 },
  { page: 'typer', id: 'assistenter' },
  { page: 'status', id: 'planlagt' },
  { page: 'sok', q: 'modell' },
  { page: 'kom-i-gang' },
];

describe('docs site routing', () => {
  it('keeps a malformed status id as written instead of failing', () => {
    expect(parseHash('#/status/%E0%A4%A')).toEqual({ page: 'status', id: '%E0%A4%A' });
  });

  it('keeps the docs site addresses by default', () => {
    expect(href({ page: 'oversikt' })).toBe('#/');
    expect(href({ page: 'byggeklosser', id: 'rag' })).toBe('#/byggeklosser/rag');
    expect(href({ page: 'tjenester', id: 'kunnskapsassistenten', del: 'bruk', steg: 3 })).toBe(
      '#/tjenester/kunnskapsassistenten?del=bruk&steg=3',
    );
    expect(parseHash('#/flyt')).toEqual({ page: 'tjenester', id: 'kunnskapsassistenten' });
    expect(parseHash('#/finnesikke')).toEqual({ page: 'ikke-funnet' });
    for (const route of routes) expect(parseHash(href(route))).toMatchObject(route);
  });

  it('serves the same pages under another prefix and with other segment names', () => {
    configureRouting({
      prefix: '#/about',
      segments: {
        malbilde: 'target-picture',
        byggeklosser: 'building-blocks',
        tjenester: 'flows',
        sok: 'search',
        typer: 'service-types',
        status: 'status',
        'kom-i-gang': 'get-started',
      },
      query: { part: 'part', step: 'step', use: 'use', setup: 'setup' },
    });

    expect(href({ page: 'oversikt' })).toBe('#/about');
    expect(href({ page: 'byggeklosser', id: 'rag' })).toBe('#/about/building-blocks/rag');
    expect(parseHash('#/about/flows/kunnskapsassistenten?part=setup&step=2')).toEqual({
      page: 'tjenester',
      id: 'kunnskapsassistenten',
      del: 'oppsett',
      steg: 2,
    });
    expect(parseHash('#/overview')).toEqual({ page: 'oversikt' });
    expect(parseHash('#/aboutsomething')).toEqual({ page: 'oversikt' });
    for (const route of routes) expect(parseHash(href(route))).toMatchObject(route);
  });
});
