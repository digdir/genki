// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QuotaRequestView } from '../../api/quota-requests';
import { exampleServices, exampleTimeline, mockFetch } from '../../mock';
import { renderAt } from '../../test-utils';
import type { UsageReport, UsageTotals } from '../../types';

const totals = (tokens: number): UsageTotals => ({
  inputTokens: Math.round(tokens * 0.9),
  outputTokens: tokens - Math.round(tokens * 0.9),
  requests: 10,
  runs: 10,
  costMicroNok: 1_000_000,
});

const report = (used: number, quota?: UsageReport['quota']): UsageReport => ({
  from: '2026-10-01T00:00:00Z',
  to: '2026-10-07T10:00:00Z',
  priced: true,
  totals: totals(used),
  daily: [
    { date: '2026-10-07', usage: totals(used), byService: { rapportassistenten: totals(used) } },
  ],
  byService: [{ service: 'rapportassistenten', usage: totals(used) }],
  byModel: [],
  ...(quota ? { quota } : {}),
});

const alerting = report(41_000_000, {
  usedTokens: 41_000_000,
  monthlyTokens: 50_000_000,
  usedPercent: 82,
  alertPercent: 80,
  alert: true,
});

const pending: QuotaRequestView = {
  id: 'qr-1',
  monthlyTokens: 100_000_000,
  reason: 'Ny tjeneste i drift',
  requestedBy: 'person:kari',
  requestedAt: '2026-10-06T12:00:00Z',
  state: 'pending',
};

interface Sent {
  body: unknown;
  reason: string | null;
}

const recording = (base: typeof fetch) => {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/quota-requests$/.test(url) && init?.method === 'POST') {
      const headers = new Headers(init.headers);
      const reason = headers.get('change-reason');
      sent.push({
        body: JSON.parse(String(init.body)),
        reason: reason === null ? null : decodeURIComponent(reason),
      });
    }
    return base(input, init);
  };
  return { fetch, sent };
};

const portal = (usage: UsageReport, quotaRequests: QuotaRequestView[] = []) =>
  mockFetch(exampleServices, [exampleTimeline], undefined, undefined, {
    usage,
    features: { platformStatus: { quotaRequests } },
  });

const openDialog = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Be om mer kvote' }));
  return screen.findByRole('dialog', { name: 'Be om mer kvote' });
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Be om mer kvote', () => {
  it('takes the quota alert from the usage quota block, even without a quota setting', async () => {
    await renderAt('#/overview', portal(alerting));

    expect(await screen.findByText('Kvote 82 %')).toBeTruthy();
    expect(screen.getByText(/41 av 50 mill. tokens er brukt i/)).toBeTruthy();
  });

  it('sends the chosen total monthly quota with the reason as the change reason', async () => {
    const { fetch, sent } = recording(portal(alerting));
    await renderAt('#/overview', fetch);
    const dialog = await openDialog();

    fireEvent.click(within(dialog).getByRole('radio', { name: /^50 mill. til, 100 mill. totalt/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Hvorfor trenger dere mer/ }), {
      target: { value: 'Postsortering tar inn all post fra desember' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send forespørselen' }));

    expect(await within(dialog).findByText('Forespørselen er sendt til Digdir.')).toBeTruthy();
    expect(sent).toEqual([
      {
        body: { monthlyTokens: 100_000_000 },
        reason: 'Postsortering tar inn all post fra desember',
      },
    ]);
  });

  it('refuses to send without an amount and a reason', async () => {
    const { fetch, sent } = recording(portal(alerting));
    await renderAt('#/overview', fetch);
    const dialog = await openDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Send forespørselen' }));

    expect(await within(dialog).findByText('Velg hvor mye dere trenger.')).toBeTruthy();
    expect(within(dialog).getByText(/minst/)).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it('refuses an other amount that is not above the quota the organisation has now', async () => {
    const { fetch, sent } = recording(portal(alerting));
    await renderAt('#/overview', fetch);
    const dialog = await openDialog();

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Annet' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Antall millioner/ }), {
      target: { value: '40' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Hvorfor trenger dere mer/ }), {
      target: { value: 'Postsortering tar inn all post fra desember' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send forespørselen' }));

    expect(await within(dialog).findByText(/Skriv et tall over 50/)).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it('shows a request that waits for a decision instead of the button', async () => {
    await renderAt('#/overview', portal(alerting, [pending]));

    expect(
      await screen.findByText(/Venter på svar fra Digdir om 100 mill. tokens per måned/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Be om mer kvote' })).toBeNull();
  });

  it('says a request is already waiting when the API refuses a second one', async () => {
    const base = portal(alerting);
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/quota-requests$/.test(url) && init?.method === 'POST')
        return Response.json(
          {
            type: 'urn:genai:problem:quota-request-pending',
            title: 'Conflict',
            status: 409,
          },
          { status: 409 },
        );
      return base(input, init);
    };
    await renderAt('#/overview', fetch);
    const dialog = await openDialog();

    fireEvent.click(within(dialog).getByRole('radio', { name: /^50 mill. til/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Hvorfor trenger dere mer/ }), {
      target: { value: 'Postsortering tar inn all post fra desember' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send forespørselen' }));

    expect(
      await within(dialog).findByText(/Det venter allerede en forespørsel om mer kvote/),
    ).toBeTruthy();
    expect(
      (
        within(dialog).getByRole('textbox', {
          name: /Hvorfor trenger dere mer/,
        }) as HTMLTextAreaElement
      ).value,
    ).toBe('Postsortering tar inn all post fra desember');
  });

  it('asks before it discards what was written', async () => {
    await renderAt('#/overview', portal(alerting));
    const dialog = await openDialog();

    fireEvent.change(within(dialog).getByRole('textbox', { name: /Hvorfor trenger dere mer/ }), {
      target: { value: 'Noe' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt' }));

    expect(await within(dialog).findByText('Forkaste det du har skrevet?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forkast' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers the request on Statistikk once the quota alert is on', async () => {
    await renderAt('#/statistics', portal(alerting));

    expect(await screen.findByRole('button', { name: 'Be om mer kvote' })).toBeTruthy();
  });

  it('offers a request on Statistikk before the quota alert too', async () => {
    await renderAt(
      '#/statistics',
      portal(
        report(10_000_000, {
          usedTokens: 10_000_000,
          monthlyTokens: 50_000_000,
          usedPercent: 20,
          alertPercent: 80,
          alert: false,
        }),
      ),
    );

    expect(await screen.findByRole('heading', { name: /Kvote i/ })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Be om mer kvote' })).toBeTruthy();
  });
});
