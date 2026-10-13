// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { blocksOf } from './AnswerText';
import { Conversation } from './Conversation';
import type { AssistantMessage } from './types';

const answer = (patch: Partial<AssistantMessage>): AssistantMessage => ({
  id: 'a1',
  role: 'assistant',
  text: '',
  lang: 'nb',
  sources: [],
  ...patch,
});

const show = (message: AssistantMessage) =>
  render(
    <Conversation
      messages={[message]}
      organisation="Digdir"
      now={new Date('2026-10-09T10:00:00Z')}
      onRetry={() => undefined}
      onFeedback={async () => undefined}
    />,
  );

afterEach(cleanup);

describe('answer text', () => {
  it('renders bold, lists and links as markup instead of literal markdown', () => {
    const { container } = show(
      answer({
        text: 'Digdirs **viktigste mål** er:\n\n- samordning\n- *felles* løsninger\n\nLes [mer](https://www.digdir.no).\n\n1. først\n2. sist',
      }),
    );
    const text = container.querySelector('.answer-text') as HTMLElement;

    expect(text.textContent).not.toContain('**');
    expect(within(text).getByText('viktigste mål').tagName).toBe('STRONG');
    expect(within(text).getByText('felles').tagName).toBe('EM');
    expect(text.querySelectorAll('ul > li')).toHaveLength(2);
    expect(text.querySelectorAll('ol > li')).toHaveLength(2);
    const link = within(text).getByRole('link', { name: 'mer' });
    expect(link.getAttribute('href')).toBe('https://www.digdir.no');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('never turns model text into HTML or a script link', () => {
    const { container } = show(
      answer({ text: '<img src=x onerror=alert(1)> [klikk](javascript:alert(1))' }),
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelector('.answer-text')?.textContent).toContain('<img');
  });

  it('links each [N] marker to the source with that number and numbers the list to match', () => {
    show(
      answer({
        text: 'Digdir skal samordne [2] og forenkle [3, 2].',
        sources: [
          { title: 'Tildelingsbrev 2024', url: 'https://kudos.dfo.no/d2', index: 2 },
          { title: 'Årsrapport 2023', index: 3 },
        ],
      }),
    );

    const cited = screen.getAllByRole('link', { name: 'Kilde 2: Tildelingsbrev 2024' });
    expect(cited).toHaveLength(2);
    expect(cited[0]?.getAttribute('href')).toBe('https://kudos.dfo.no/d2');
    const unlinked = screen.getByRole('link', { name: 'Kilde 3: Årsrapport 2023' });
    const target = document.getElementById(unlinked.getAttribute('href')?.slice(1) ?? '');
    expect(target?.textContent).toContain('Årsrapport 2023');
    expect(target?.getAttribute('value')).toBe('3');
  });

  it('opens a source from the source list in a new tab', () => {
    show(
      answer({
        text: 'Svar [1].',
        sources: [{ title: 'Tildelingsbrev 2024', url: 'https://kudos.dfo.no/d1', index: 1 }],
      }),
    );

    const listed = within(document.querySelector('ol.sources') as HTMLElement).getByRole('link', {
      name: 'Tildelingsbrev 2024',
    });
    expect(listed.getAttribute('href')).toBe('https://kudos.dfo.no/d1');
    expect(listed.getAttribute('target')).toBe('_blank');
  });

  it('leaves a marker with no matching source as plain text', () => {
    show(answer({ text: 'Svar [4].', sources: [{ title: 'Uten nummer' }] }));
    expect(screen.queryByRole('link', { name: /Kilde 4/ })).toBeNull();
    expect(document.querySelector('.answer-text')?.textContent).toBe('Svar [4].');
  });

  it('splits text into paragraphs, headings, lists and code blocks', () => {
    expect(blocksOf('## Mål\nLinje en\nlinje to\n\n- a\n  fortsatt\n- b\n```\nkode\n```')).toEqual([
      { kind: 'heading', text: 'Mål' },
      { kind: 'paragraph', lines: ['Linje en', 'linje to'] },
      { kind: 'list', ordered: false, start: 1, items: ['a fortsatt', 'b'] },
      { kind: 'code', text: 'kode' },
    ]);
  });

  it('nests indented sub-bullets under the numbered item they follow', () => {
    const { container } = show(
      answer({
        text: '1. **Første**: tekst\n2. **Andre**: tekst\n   - under a\n   - under b\n3. Tredje',
      }),
    );

    const items = [...container.querySelectorAll('.answer-text > ol > li')];
    expect(items).toHaveLength(3);
    expect(
      [...(items[1]?.querySelectorAll(':scope > ul > li') ?? [])].map((li) => li.textContent),
    ).toEqual(['under a', 'under b']);
    expect(container.querySelectorAll('.answer-text ol')).toHaveLength(1);
  });
});
