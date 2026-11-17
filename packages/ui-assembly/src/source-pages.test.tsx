// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Sources } from '@genai/ui-blocks';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceFromWire } from './api.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

describe('pages from genki to the sources block', () => {
  it('the sources block shows «side N» and «Les side N» for an excerpt from the knowledge database', () => {
    const pdf = 'https://kudos.dfo.no/dokument/d1/filer/f1.pdf';
    // As /v1 sends a source whose chunks the knowledge database placed on their pages.
    const wire = {
      index: 1,
      title: 'Rapport om sykepenger',
      url: 'https://kudos.dfo.no/dokument/d1',
      document_id: 'kudos:d1',
      excerpts: [
        {
          chunk_id: 'c1',
          text: 'Nav sikrer ikke utbetalingene.',
          heading: '1 Sammendrag',
          page: 6,
          page_end: 7,
          url: `${pdf}#page=6`,
        },
        { chunk_id: 'c2', text: 'Risikomodulen.', heading: '2.3 Risiko', page: 9 },
      ],
    };
    render(<Sources sources={[sourceFromWire(wire)]} corpus="Kudos" />);
    const rowOf = (name: RegExp) =>
      screen.getByRole('heading', { name }).closest('.uib-sources-excerpt') as HTMLElement;
    for (const name of [/1 Sammendrag/, /2.3 Risiko/])
      fireEvent.click(within(rowOf(name)).getByRole('button', { name: /^(Åpne|Open) / }));

    expect(within(rowOf(/1 Sammendrag/)).getByText('side 6–7')).toBeTruthy();
    expect(
      within(rowOf(/1 Sammendrag/))
        .getByRole('link', { name: /^Les side 6 på Kudos/ })
        .getAttribute('href'),
    ).toBe(`${pdf}#page=6`);
    expect(within(rowOf(/2.3 Risiko/)).getByText('side 9')).toBeTruthy();
    expect(within(rowOf(/2.3 Risiko/)).queryByRole('link', { name: /Les side/ })).toBeNull();
  });
});
