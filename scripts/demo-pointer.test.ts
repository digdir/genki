import { describe, expect, it } from 'vitest';
import {
  centre,
  changesPage,
  focusArea,
  focusTarget,
  navigates,
  glideMs,
  refOf,
  scrollBy,
  smoothScrollScript,
  targetOf,
  voiceCue,
} from './demo-pointer.ts';

const snapshot = `--- AGENT_BROWSER_PAGE_CONTENT nonce=1 origin=http://localhost/ ---
- generic "Tjenester Statistikk Logg" [ref=e1] clickable
  - navigation "Meny" [ref=e2]
    - link "Tjenester" [ref=e3]
    - link "Delte tjenester" [ref=e4]
    - link "Logg" [ref=e5]
  - heading "Trenger deg nå" [level=2, ref=e6]
  - region "Kort" [ref=e7]
    - paragraph [ref=e8]
      - StaticText "Kvoten er brukt opp"
  - textbox "Formål" [ref=e9]
  - link "Si \\"hei\\" til oss" [ref=e10]
--- END_AGENT_BROWSER_PAGE_CONTENT nonce=1 ---`;

describe('the recorded pointer', () => {
  it('points at the element a find, click or hover names, and not at a find that only reads text', () => {
    expect(targetOf(['find', 'role', 'link', 'click', '--name', 'Tjenester', '--exact'])).toEqual({
      by: 'role',
      role: 'link',
      name: 'Tjenester',
      exact: true,
    });
    expect(targetOf(['find', 'text', 'Trenger deg nå', 'hover'])).toEqual({
      by: 'name',
      name: 'Trenger deg nå',
      exact: false,
      text: true,
    });
    expect(targetOf(['hover', '#menu'])).toEqual({ by: 'selector', selector: '#menu' });
    expect(targetOf(['find', 'role', 'heading', 'text', '--name', 'X'])).toBeUndefined();
    expect(targetOf(['open', 'https://x'])).toBeUndefined();
    expect(targetOf(['wait', '--text', 'Klar'])).toBeUndefined();
  });

  it('finds the first element with the role and a name containing the text, or exactly the name with --exact', () => {
    expect(refOf(snapshot, { by: 'role', role: 'link', name: 'tjenester', exact: false })).toBe(
      'e3',
    );
    expect(refOf(snapshot, { by: 'role', role: 'link', name: 'Delte', exact: true })).toBe(
      undefined,
    );
    expect(refOf(snapshot, { by: 'role', role: 'LINK', name: 'Logg', exact: true })).toBe('e5');
  });

  it('never points at a generic wrapper whose name happens to contain the text', () => {
    expect(refOf(snapshot, { by: 'name', name: 'Statistikk', exact: false, text: true })).toBe(
      undefined,
    );
  });

  it('points at the element around a text that has no reference of its own', () => {
    expect(refOf(snapshot, { by: 'name', name: 'Kvoten', exact: false, text: true })).toBe('e8');
  });

  it('finds a field by its label, and reads escaped quotes in a name', () => {
    expect(refOf(snapshot, { by: 'name', name: 'Formål', exact: false, text: false })).toBe('e9');
    expect(refOf(snapshot, { by: 'role', role: 'link', name: 'Si "hei"', exact: false })).toBe(
      'e10',
    );
  });

  it('reads a long hostile snapshot line in linear time', () => {
    const hostile = `- link "${'\\"'.repeat(50_000)}${'a'.repeat(50_000)}`;
    const started = performance.now();
    refOf(hostile, { by: 'role', role: 'link', name: 'x', exact: false });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('glides longer the further it goes, never instantly and never slowly', () => {
    const from = { x: 0, y: 0 };
    expect(glideMs(from, { x: 1, y: 1 })).toBe(450);
    expect(glideMs(from, { x: 600, y: 0 })).toBe(660);
    expect(glideMs(from, { x: 1900, y: 1000 })).toBe(1100);
  });

  it('aims at the middle of a small element and near the top of a tall one', () => {
    expect(centre({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ x: 60, y: 40 });
    expect(centre({ x: 0, y: 100, width: 800, height: 900 })).toEqual({ x: 400, y: 140 });
  });

  it('scrolls only when the target is near or past the edge of the screen', () => {
    expect(scrollBy({ x: 0, y: 500, width: 10, height: 10 }, 1080)).toBe(0);
    expect(scrollBy({ x: 0, y: 1500, width: 10, height: 10 }, 1080)).toBe(1505 - 486);
    expect(scrollBy({ x: 0, y: -400, width: 10, height: 10 }, 1080)).toBe(-395 - 486);
  });

  it('puts only a number into the scroll script', () => {
    expect(smoothScrollScript(Number('1;alert(1)'))).toContain('top:0,');
    expect(smoothScrollScript(240)).toContain("top:240,behavior:'smooth'");
    expect(smoothScrollScript(Infinity)).toContain('top:0,');
    expect(smoothScrollScript(239.6)).toContain('top:240,');
  });

  it('starts the voice after the last command that changes the page, so it never talks over a loading screen', () => {
    expect(voiceCue([])).toBe(-1);
    expect(voiceCue([['find', 'text', 'Kvote', 'hover']])).toBe(-1);
    expect(
      voiceCue([
        ['find', 'role', 'link', 'click', '--name', 'Logg'],
        ['wait', '--text', 'Hva tjenestene har gjort'],
        ['find', 'role', 'tab', 'hover', '--name', 'Endringer'],
      ]),
    ).toBe(1);
    expect(changesPage(['scrollintoview', '#x'])).toBe(false);
    expect(changesPage(['open', 'https://x'])).toBe(true);
  });

  it('counts a click, an open or a history move as leaving the page, and a hover or wait as staying', () => {
    expect(navigates(['find', 'role', 'link', 'click', '--name', 'Logg'])).toBe(true);
    expect(navigates(['open', 'https://x'])).toBe(true);
    expect(navigates(['back'])).toBe(true);
    expect(navigates(['find', 'text', 'Kvote', 'hover'])).toBe(false);
    expect(navigates(['wait', '--text', 'Klar'])).toBe(false);
  });

  it('reads a focus as a role with an optional name, a text, a label or a CSS selector', () => {
    expect(focusTarget(['role', 'table'])).toEqual({
      by: 'role',
      role: 'table',
      name: '',
      exact: false,
    });
    expect(focusTarget(['text', 'Hvor data behandles'])).toEqual({
      by: 'name',
      name: 'Hvor data behandles',
      exact: false,
      text: true,
    });
    expect(focusTarget(['css', 'main table'])).toEqual({ by: 'selector', selector: 'main table' });
    expect(focusTarget(['eval', 'x'])).toBeUndefined();
    expect(focusTarget(['role'])).toBeUndefined();
  });

  it('widens a small focus to a readable area from its top left, inside the screen', () => {
    expect(focusArea({ x: 400, y: 300, width: 120, height: 30 }, [1920, 1080])).toEqual({
      x: 384,
      y: 284,
      width: 864,
      height: 432,
    });
    expect(focusArea({ x: 1800, y: 1000, width: 100, height: 40 }, [1920, 1080])).toEqual({
      x: 1056,
      y: 648,
      width: 864,
      height: 432,
    });
  });

  it('falls back to the element of a landmark role the snapshot gives no reference', () => {
    expect(refOf(snapshot, { by: 'role', role: 'table', name: '', exact: false })).toBe('table');
    expect(refOf(snapshot, { by: 'role', role: 'table', name: 'Modeller', exact: false })).toBe(
      undefined,
    );
  });
});
