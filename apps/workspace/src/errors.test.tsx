// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  failureCopy,
  failureFromAnswer,
  failureFromHttp,
  failureFromStreamError,
  platformMessages,
} from './failures';
import { createWorkspaceApi } from './api';
import { Conversation } from './Conversation';
import { exampleFailures, mockWorkspaceApi } from './mock';
import { expectAccessible, fixedNow, renderApp } from './testing';

document.getAnimations ??= () => [];

afterEach(cleanup);

describe('error messages', () => {
  it('shows quota, outage, refused topic and no sources in plain language without codes', async () => {
    let retried = 0;
    const { container } = render(
      <div lang="nb">
        <Conversation
          messages={exampleFailures}
          organisation="Testetaten"
          now={fixedNow()}
          onRetry={() => {
            retried += 1;
          }}
          onFeedback={async () => undefined}
        />
      </div>,
    );
    const conversation = screen.getByRole('list', { name: 'Samtale' });
    const expected = [
      [
        'Kvoten er brukt opp',
        'Testetaten har brukt hele kvoten for oktober. Tjenesten virker igjen 1. november, eller når en administrator øker kvoten. Det du skrev, er ikke lagret.',
      ],
      [
        'Språkmodellen svarer ikke akkurat nå',
        'Det er ikke noe galt med spørsmålet ditt. Prøv igjen om noen minutter.',
      ],
      [
        'Dette kan jeg ikke svare på',
        'Tjenesten svarer ikke på spørsmål om lønn, helse eller andre forhold for enkeltpersoner. Kontakt HR-avdelingen.',
      ],
      [
        'Fant ingen kilder',
        'Jeg fant ikke noe i rapportene som svarer på dette, så jeg svarer ikke. Prøv andre ord, eller søk direkte i Kudos.',
      ],
    ];
    for (const [title, text] of expected) {
      expect(within(conversation).getByText(title as string)).toBeTruthy();
      expect(within(conversation).getByText(text as string)).toBeTruthy();
    }
    expect(conversation.textContent).not.toMatch(/\b(4\d\d|5\d\d)\b|error|_/i);
    expect(
      within(conversation).queryByRole('group', { name: 'Tilbakemelding på svaret' }),
    ).toBeNull();
    expectAccessible(container);

    fireEvent.click(within(conversation).getByRole('button', { name: 'Prøv igjen' }));
    expect(retried).toBe(1);
  });

  it('maps platform error responses to the plain-language kinds', () => {
    expect(failureFromHttp(429, { error: { code: 'rate_limit_exceeded' } })).toEqual({
      kind: 'quota',
    });
    expect(failureFromHttp(500, { error: { code: 'budget_exceeded' } })).toEqual({ kind: 'quota' });
    expect(failureFromHttp(503, undefined)).toEqual({ kind: 'unavailable' });
    expect(failureFromHttp(500, { error: { code: 'internal_error' } })).toEqual({
      kind: 'unavailable',
    });
    expect(failureFromHttp(401, { error: { code: 'invalid_api_key' } })).toEqual({
      kind: 'signed-out',
    });
    expect(failureFromHttp(403, { error: { code: 'agent_not_authorized' } })).toEqual({
      kind: 'no-access',
    });
    expect(failureFromHttp(404, { error: { code: 'model_not_found' } })).toEqual({
      kind: 'no-access',
    });
    expect(failureFromStreamError('Error: budget exceeded for tenant')).toEqual({ kind: 'quota' });
    expect(failureFromStreamError('Error: the model is unavailable')).toEqual({
      kind: 'unavailable',
    });
    expect(failureFromAnswer(platformMessages.topic)).toEqual({ kind: 'refused' });
    expect(failureFromAnswer(platformMessages.sources)).toEqual({ kind: 'no-sources' });
    expect(failureFromAnswer('Et vanlig svar.')).toBeUndefined();
  });

  it('writes generic copy when the platform gives no message', () => {
    const context = { organisation: 'Testetaten', now: fixedNow() };
    expect(failureCopy({ kind: 'refused' }, context).text).toBe(
      'Tjenesten svarer ikke på denne typen spørsmål.',
    );
    expect(
      failureCopy({ kind: 'quota' }, { ...context, now: new Date('2026-12-15') }).text,
    ).toContain('kvoten for desember. Tjenesten virker igjen 1. januar');
    expect(failureCopy({ kind: 'unavailable' }, context).action).toBe('Prøv igjen');
    expect(failureCopy({ kind: 'service-failed' }, context)).toEqual({
      color: 'danger',
      title: 'Tjenesten feilet',
      text: 'Noe gikk galt i tjenesten, ikke i spørsmålet ditt. Prøv igjen, eller se Feilmeldinger.',
      action: 'Prøv igjen',
    });
  });

  it('does not talk about a form when the input a plain question could not be used', () => {
    const copy = failureCopy(
      { kind: 'invalid-input' },
      { organisation: 'Testetaten', now: fixedNow() },
    );

    expect(copy.title.toLowerCase()).not.toContain('skjema');
  });
});

describe('your own failed runs', () => {
  it('lists them with the step in bold and a reason a user can read, from the API', async () => {
    const asked: string[] = [];
    const api = createWorkspaceApi({
      baseUrl: '/api',
      token: () => 'kari',
      fetch: async (input) => {
        asked.push(String(input));
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 't1',
                service: 'maloppnaelse',
                serviceName: 'Vurdering av måloppnåelse',
                createdAt: '2026-10-07T08:14:00Z',
                status: 'failed',
                failure: {
                  code: 'strategy_error',
                  step: 'finn',
                  reason: 'Steget «finn» feilet. Tjenesten feilet underveis.',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const { container } = await renderApp('#/errors', {
      api: {
        ...mockWorkspaceApi(),
        failedRuns: (tenant, signal) => api.failedRuns?.(tenant, signal) ?? Promise.resolve([]),
      },
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Feilmeldinger' })).toBeTruthy();
    const item = (
      await screen.findByRole('heading', { level: 2, name: 'Vurdering av måloppnåelse' })
    ).closest('li') as HTMLElement;
    expect(within(item).getByText('Steget «finn» feilet.').tagName).toBe('STRONG');
    expect(item.textContent).toContain('Tjenesten feilet underveis.');
    expect(item.textContent).toContain('I dag kl. 10.14');
    expect(
      within(item)
        .getByRole('link', { name: 'Prøv igjen med Vurdering av måloppnåelse' })
        .getAttribute('href'),
    ).toBe('#/chat?service=maloppnaelse');
    expect(asked.at(-1)).toMatch(/^\/api\/tenants\/\d+\/tasks\/mine\?status=failed$/);
    expectAccessible(container);
  });

  it('says so when nothing has failed in the last 30 days', async () => {
    await renderApp('#/errors', {
      api: {
        ...mockWorkspaceApi(),
        failedRuns: async () => [
          {
            id: 'old',
            service: 'gammel',
            at: '2026-08-01T10:00:00Z',
            reason: 'Tjenesten feilet underveis.',
          },
        ],
      },
    });

    expect(
      await screen.findByText('Ingen av kjøringene dine har feilet de siste 30 dagene.'),
    ).toBeTruthy();
    expect(screen.queryByText('gammel')).toBeNull();
  });

  it('opens the service again from the retry link', async () => {
    await renderApp('#/chat?service=maloppnaelse');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Vurdering av måloppnåelse' }),
    ).toBeTruthy();
  });
});
