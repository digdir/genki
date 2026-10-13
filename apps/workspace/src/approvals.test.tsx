// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { exampleApprovals, mockApprovalsApi } from './mock';
import { expectAccessible, renderApp } from './testing';
import type { ApprovalsApi, Decision } from './types';

document.getAnimations ??= () => [];

afterEach(cleanup);

const inbox = () => screen.getByRole('region', { name: 'Til godkjenning' });

describe('approvals', () => {
  it('lists pending drafts with due date, service, case and a preview, and shows the first', async () => {
    const { container } = await renderApp('#/approvals');
    await screen.findByText('Frist i dag');
    const items = within(inbox()).getAllByRole('button');
    expect(items).toHaveLength(3);
    const first = items[0] as HTMLElement;
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(within(first).getByText('Vedtaksutkast · sak 2026/1432')).toBeTruthy();
    expect(
      within(first).getByText(/^Vi har behandlet søknaden fra Eksempel Idrettslag.*…$/),
    ).toBeTruthy();

    const detail = screen.getByRole('region', {
      name: 'Vedtak om tilskudd til Eksempel Idrettslag',
    });
    expect(within(detail).getByText('I dag')).toBeTruthy();
    expect(within(detail).getByText('Saksbehandlere tilskudd')).toBeTruthy();
    expect(within(detail).getByText('Utkast laget med KI')).toBeTruthy();
    expect(
      within(detail).getByRole('link', { name: 'Se hva tjenesten brukte som grunnlag' }),
    ).toBeTruthy();
    expect(
      within(detail).getByText(
        'Navnet ditt lagres med beslutningen. Det er ansvar for beslutninger, ikke overvåking.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: /Til godkjenning/ }).textContent).toContain(
      'Til godkjenning',
    );
    expect(screen.getByLabelText('3 venter på deg')).toBeTruthy();
    expectAccessible(container);
  });

  it('requires a comment to reject and links the error to the field', async () => {
    const decisions: [string, Decision, string][] = [];
    const api: ApprovalsApi = {
      ...mockApprovalsApi(),
      resolve: async (id, decision, comment) => {
        decisions.push([id, decision, comment]);
      },
    };
    const { container } = await renderApp('#/approvals', { approvals: api });
    fireEvent.click(await screen.findByRole('button', { name: 'Avvis' }));
    const comment = screen.getByRole('textbox', { name: 'Kommentar' });
    expect(screen.getByText('Skriv hvorfor du avviser utkastet.')).toBeTruthy();
    expect(comment.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(comment);
    expect(decisions).toEqual([]);
    expectAccessible(container);

    fireEvent.change(comment, { target: { value: 'Beløpet er feil.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Avvis' }));
    await screen.findByText(
      'Vedtak om tilskudd til Eksempel Idrettslag er avvist. Tjenesten får beskjed, og kommentaren din blir en tilbakemelding.',
    );
    expect(decisions).toEqual([['g1', 'rejected', 'Beløpet er feil.']]);
  });

  it('approves, moves the draft to "Behandlet i dag" and opens the next one', async () => {
    await renderApp('#/approvals');
    fireEvent.click(await screen.findByRole('button', { name: 'Godkjenn' }));
    await screen.findByText(
      'Vedtak om tilskudd til Eksempel Idrettslag er godkjent og sendt til saken.',
    );
    const done = screen.getByRole('heading', { name: 'Behandlet i dag' })
      .parentElement as HTMLElement;
    expect(within(done).getByText('Godkjent')).toBeTruthy();
    expect(within(done).getByText('Vedtak om tilskudd til Eksempel Idrettslag')).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'Vedtak om tilskudd til Elvebakken Musikkorps' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('2 venter på deg')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('detail-heading'));
  });

  it('shows the empty state when nothing is waiting', async () => {
    await renderApp('#/approvals', { approvals: mockApprovalsApi([]) });
    await screen.findByText('Ingen utkast venter på deg.');
    expect(screen.getByText('Nye utkast dukker opp her, og du får varsel på e-post.')).toBeTruthy();
    expect(screen.getByText('Velg et utkast for å se det.')).toBeTruthy();
    expect(screen.queryByLabelText(/venter$/)).toBeNull();
  });

  it('reaches the empty state after the last draft is handled', async () => {
    await renderApp('#/approvals', {
      approvals: mockApprovalsApi(exampleApprovals.slice(2)),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Godkjenn' }));
    await screen.findByText('Ingen utkast venter på deg.');
    expect(screen.getByText('Svar på innsynskrav fra Prøveavisa')).toBeTruthy();
  });

  it('shows an error with retry when drafts cannot be loaded', async () => {
    let fail = true;
    const api: ApprovalsApi = {
      listPending: async () => {
        if (fail) throw new Error('down');
        return exampleApprovals;
      },
      resolve: async () => undefined,
    };
    await renderApp('#/approvals', { approvals: api });
    await screen.findByText('Kunne ikke hente utkastene');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await screen.findByText('Frist i dag');
  });

  it('keeps the draft and says so when the decision cannot be saved', async () => {
    const api: ApprovalsApi = {
      ...mockApprovalsApi(),
      resolve: async () => {
        throw new Error('down');
      },
    };
    await renderApp('#/approvals', { approvals: api });
    fireEvent.click(await screen.findByRole('button', { name: 'Godkjenn' }));
    await screen.findByText('Beslutningen ble ikke lagret. Prøv igjen om litt.');
    expect(screen.getByLabelText('3 venter på deg')).toBeTruthy();
  });
});
