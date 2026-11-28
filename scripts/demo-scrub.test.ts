// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { scrubScript } from './demo.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('hiding retired and internal words before a capture', () => {
  it('hides the element that holds the word, also when the page adds it later, and leaves the rest', async () => {
    document.body.innerHTML =
      '<nav><a href="#/a">Tjenester</a><a href="#/w">Workspace</a></nav><p>Søk med Typesense i dag</p><h2>Katalog</h2>';
    window.requestAnimationFrame = (run) => setTimeout(() => run(0), 0) as unknown as number;
    new Function(scrubScript(['Workspace', 'Typesense']))();
    const shown = (text: string) =>
      [...document.querySelectorAll<HTMLElement>('a, p, h2, li')].find((e) =>
        e.textContent?.includes(text),
      )?.style.display !== 'none';

    expect(shown('Workspace')).toBe(false);
    expect(shown('Typesense')).toBe(false);
    expect(shown('Tjenester')).toBe(true);
    expect(shown('Katalog')).toBe(true);

    const late = document.createElement('li');
    late.textContent = 'Åpne KI-arbeidsflaten og Workspace';
    document.body.append(late);
    await settle();
    expect(late.style.display).toBe('none');
  });

  it('blanks a word that sits loose in a container instead of hiding the container', () => {
    document.body.innerHTML = '<div id="root">Workspace<section>Tjenester</section></div>';
    new Function(scrubScript(['Workspace']))();
    const root = document.getElementById('root') as HTMLElement;
    expect(root.style.display).toBe('');
    expect(root.textContent).toBe('Tjenester');
  });

  it('does nothing when there are no words to hide', () => {
    document.body.innerHTML = '<p>Workspace</p>';
    new Function(scrubScript([]))();
    expect((document.querySelector('p') as HTMLElement).style.display).toBe('');
  });
});
