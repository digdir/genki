// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { exampleDraft } from './mock';
import { PROVENANCE_MIME, provenanceOf } from './provenance';
import { expectAccessible, renderApp } from './testing';
import type { DocumentDraft } from './types';

document.getAnimations ??= () => [];

afterEach(cleanup);

const withProvenance = (change: Record<string, unknown> | undefined): DocumentDraft => ({
  ...exampleDraft,
  parts: exampleDraft.parts.flatMap((p) => {
    if (p.mime !== PROVENANCE_MIME) return [p];
    if (!change) return [];
    const json = p.body.kind === 'json' ? (p.body.json as object) : {};
    return [{ ...p, body: { kind: 'json' as const, json: { ...json, ...change } } }];
  }),
});

describe('document draft', () => {
  it('marks the draft with a warning at the top and provenance at the bottom', async () => {
    const { container } = await renderApp('#/document');
    const article = await screen.findByRole('article', {
      name: 'Vedtak om tilskudd til Eksempel Idrettslag',
    });
    const banner = within(article).getByRole('note');
    expect(banner.textContent).toContain('Utkast laget med KI');
    expect(banner.textContent).toContain(
      'Kontroller innholdet før det sendes. Merket fjernes først når en saksbehandler har godkjent utkastet.',
    );
    expect(article.querySelector('footer')?.textContent).toBe(
      'Utkast laget med KI av tjenesten Vedtaksutkast, versjon 7, 6. oktober 2026 kl. 09.12. Grunnlag: søknaden og vedleggene i sak 2026/1432 og forskriften § 4.',
    );
    expect(
      within(article).getByText('Testetaten · Saksnummer 2026/1432 · 6. oktober 2026'),
    ).toBeTruthy();
    expect(within(article).getByText(/Dere får 85 000 kroner\./)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Vedtaksutkast' })).toBeTruthy();
    expectAccessible(container);
  });

  it('reads provenance from the part with the provenance media type', () => {
    expect(provenanceOf(exampleDraft.parts)?.service?.capability.version).toBe('7');
    expect(provenanceOf([{ mime: 'text/plain', body: { kind: 'text', text: 'x' } }])).toBe(
      undefined,
    );
  });

  it('drops the warning only once a caseworker has approved the draft', async () => {
    await renderApp('#/document', { draft: withProvenance({ approved: true }) });
    const article = await screen.findByRole('article');
    expect(within(article).queryByRole('note')).toBeNull();
    expect(article.querySelector('footer')?.textContent).toMatch(
      /^Laget med KI av tjenesten Vedtaksutkast og godkjent av saksbehandler, versjon 7/,
    );
  });

  it('keeps the warning and says so when provenance is missing', async () => {
    await renderApp('#/document', { draft: withProvenance(undefined) });
    const article = await screen.findByRole('article');
    expect(within(article).getByRole('note')).toBeTruthy();
    expect(article.querySelector('footer')?.textContent).toContain(
      'Vi fant ikke opplysninger om hvordan utkastet ble laget.',
    );
  });

  it('explains the Word download and goes to approvals', async () => {
    await renderApp('#/document');
    fireEvent.click(await screen.findByRole('button', { name: 'Last ned som Word' }));
    expect(screen.getByText(/Word-filen får merket i topp- og bunntekst/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Gå til godkjenning' }));
    await waitFor(() => expect(window.location.hash).toBe('#/approvals'));
    await screen.findByRole('heading', { name: 'Til godkjenning', level: 1 });
  });
});
