// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentLink, PageLink } from './Sources.js';
import type { SourceDocument } from './types.js';

afterEach(cleanup);

const source: SourceDocument = {
  title: 'Årsrapport 2023',
  documentId: '42',
  url: 'https://kudos.example/42',
  excerpts: [],
};

// Designsystemet sets a link's icon off from its words only when the words are in a span
// (`.ds-link:has(> span) > svg:last-child`), as kunnskapsassistenten's links have them. A link
// named in one piece by `aria-label` still needs the span for the look.
const wordsThenIcon = (link: HTMLElement) => {
  const [words, icon, ...rest] = [...link.children];
  return { words: words?.tagName, text: words?.textContent, icon: icon?.tagName, rest };
};

describe('the links out of Sources', () => {
  it('keeps «Les dokumentet»’s words in a span before the icon, so the icon stands off as in kunnskapsassistenten', () => {
    render(
      <DocumentLink
        source={source}
        title="Årsrapport 2023"
        corpus="Kudos"
        linkClassName="link"
        noLinkClassName="none"
      />,
    );
    const link = screen.getByRole('link', {
      name: 'Les dokumentet på Kudos, Årsrapport 2023 (åpnes i ny fane)',
    });
    expect(wordsThenIcon(link)).toEqual({
      words: 'SPAN',
      text: 'Les dokumentet på Kudos',
      icon: 'svg',
      rest: [],
    });
  });

  it('keeps «Les side N»’s words in a span before the icon, so the icon stands off as in kunnskapsassistenten', () => {
    render(
      <PageLink
        href="https://kudos.example/42#page=8"
        page={8}
        name="utdrag 1"
        title="Årsrapport 2023"
        corpus="Kudos"
        className="link"
      />,
    );
    const link = screen.getByRole('link', {
      name: 'Les side 8 på Kudos, utdrag 1, Årsrapport 2023 (åpnes i ny fane)',
    });
    expect(wordsThenIcon(link)).toEqual({
      words: 'SPAN',
      text: 'Les side 8 på Kudos',
      icon: 'svg',
      rest: [],
    });
  });
});
