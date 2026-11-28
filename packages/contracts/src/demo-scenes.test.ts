import { describe, expect, it } from 'vitest';
import { definitionIdPattern, pageProblem, sceneProblem } from './demo-scenes.js';

describe('demo scenes', () => {
  it('accepts each template with its own fields', () => {
    expect(
      sceneProblem({
        template: 'title',
        title: 'Hver KI-tjeneste trenger det samme',
        centre: 'KI-tjeneste',
        items: ['Drift', { text: 'Innlogging', cue: 'innlogging' }],
      }),
    ).toBeUndefined();
    expect(sceneProblem({ template: 'title', logo: true, subtitle: 'Felles' })).toBeUndefined();
    expect(
      sceneProblem({ template: 'screen', title: 'Tjenestene', question: 'Og så?' }),
    ).toBeUndefined();
    expect(
      sceneProblem({
        template: 'board',
        title: 'Hvor langt vi har kommet',
        columns: [{ title: 'Bygget', mark: 'done', items: ['API'] }],
      }),
    ).toBeUndefined();
    expect(
      sceneProblem({
        template: 'code',
        title: 'KA',
        definition: 'kunnskapsassistenten',
        lines: 13,
      }),
    ).toBeUndefined();
    expect(sceneProblem({ template: 'close', address: 'genki.digdir.cloud' })).toBeUndefined();
  });

  it('refuses a scene without a known template, or with a field from another template', () => {
    expect(sceneProblem({ title: 'Uten mal' })).toMatch(/template/);
    expect(sceneProblem({ template: 'video', title: 'X' })).toMatch(/template/);
    expect(sceneProblem({ template: 'screen', title: 'X', columns: [] })).toMatch(/not columns/);
    expect(sceneProblem({ template: 'title' })).toMatch(/title or the logo/);
  });

  it('refuses a board column without a done, now or next mark', () => {
    expect(
      sceneProblem({
        template: 'board',
        title: 'Tavle',
        columns: [{ title: 'Snart', mark: 'soon', items: ['A'] }],
      }),
    ).toMatch(/mark/);
  });

  it('quotes at most 14 lines of a definition, so the code fits beside the caption', () => {
    const code = (lines: number) =>
      sceneProblem({ template: 'code', title: 'KA', definition: 'kunnskapsassistenten', lines });
    expect(code(14)).toBeUndefined();
    expect(code(15)).toMatch(/lines is 3 to 14/);
  });

  it('bounds the number of items and lines a scene may show', () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => `Punkt ${i}`);
    expect(sceneProblem({ template: 'title', title: 'T', items: items(6) })).toBeUndefined();
    expect(sceneProblem({ template: 'title', title: 'T', items: items(7) })).toMatch(/1 to 6/);
    expect(
      sceneProblem({ template: 'title', title: 'T', items: [{ text: 'A', colour: 'red' }] }),
    ).toMatch(/items/);
    expect(
      sceneProblem({ template: 'code', title: 'KA', definition: 'kunnskapsassistenten', lines: 2 }),
    ).toMatch(/lines is 3/);
  });

  it('checks a page and a definition id in linear time on a long adversarial string', () => {
    const long = `/${'/a'.repeat(50_000)} `;
    const started = performance.now();
    expect(pageProblem(long)).toMatch(/path/);
    expect(definitionIdPattern.test(`${'a-'.repeat(50_000)}!`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('names an example definition by id in a code scene, never a path', () => {
    expect(sceneProblem({ template: 'code', title: 'X', definition: '../../etc/passwd' })).toMatch(
      /definition/,
    );
    expect(sceneProblem({ template: 'code', title: 'X', definition: 'Ka.yaml' })).toMatch(
      /definition/,
    );
  });

  it('takes a page only as a path on the demo app, never another host, also not by a backslash', () => {
    expect(pageProblem('/#/developer/frontends')).toBeUndefined();
    expect(pageProblem('//evil.example/#/x')).toMatch(/path/);
    expect(pageProblem('https://evil.example/')).toMatch(/path/);
    expect(pageProblem('/with space')).toMatch(/path/);
    expect(pageProblem('/\\evil.example')).toMatch(/path/);
    expect(pageProblem('/#/a\\b')).toMatch(/path/);
  });
});
