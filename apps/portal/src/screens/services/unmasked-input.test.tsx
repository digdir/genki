// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import type { ApiClient } from '../../api';
import { mockAnsattporten } from '../../auth';
import { logTimelines } from '../../data/log';
import type { ServiceDefinition } from '../../data/service-definition';
import { refusedUnmaskedInput } from '../../data/unmasked-input';
import { exampleDatasets, exampleOrganisations, mockFetch } from '../../mock';
import type { ModelOption, PublishedDefinition, UnmaskedInputUse } from '../../types';
import { OverviewSection } from '../service/OverviewSection';

document.getAnimations ??= () => [];
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

const models: ModelOption[] = [
  { id: 'foundry-openai/gpt-4.1-mini', residency: 'global', capabilities: ['stream'] },
];

const textUse: UnmaskedInputUse = {
  flow: 'uttrekk@1',
  step: 'extract',
  stepName: 'Hent ut feltene',
  descriptor: 'example/extract@1',
  operation: 'extract',
  mediaType: 'text/plain',
};
const imageUse: UnmaskedInputUse = { ...textUse, step: 'describe', mediaType: 'image/png' };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const platform = (
  options: {
    unmasked?: UnmaskedInputUse[];
    publish?: (body: unknown) => Response | undefined;
  } = {},
) => {
  const calls: Call[] = [];
  const base = mockFetch([], logTimelines, models, exampleDatasets);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body });
    if (url.endsWith('/definitions/validate'))
      return Response.json({
        valid: true,
        ...(options.unmasked ? { unmaskedInput: options.unmasked } : {}),
      });
    if (method === 'POST' && url.endsWith('/api/definitions')) {
      const reply = options.publish?.(body);
      if (reply) return reply;
    }
    return base(input, init);
  };
  return { calls, fetch };
};

const openPublish = async (fetch: typeof globalThis.fetch) => {
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = '#/services/new';
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByRole('heading', { name: 'Lag med KI' });
  fireEvent.change(screen.getByLabelText('Hva skal tjenesten gjøre?'), {
    target: { value: 'Hent ut felter fra innsendte filer' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start med assistenten' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Bekreft risikonivå' }));
  fireEvent.click(screen.getByRole('button', { name: 'Publiser' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Hva er endret, og hvorfor?'), {
    target: { value: 'Første versjon av tjenesten' },
  });
  return dialog;
};

const published = (calls: Call[]) =>
  calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/definitions'));

const publishButton = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: 'Publiser' });

describe('unmasked input in the publish dialog', () => {
  it('publish is refused without a reason for each unmasked type', async () => {
    const { calls, fetch } = platform({ unmasked: [textUse, imageUse] });
    const dialog = await openPublish(fetch);
    const text = await within(dialog).findByLabelText('Begrunnelse for text/plain');
    expect(
      within(dialog).getByText(
        'Tekstfiler (text/plain) sendes umaskert i steget «Hent ut feltene» i oppskriften uttrekk@1.',
      ),
    ).toBeTruthy();
    fireEvent.change(text, { target: { value: 'Innsendte skjemaer må leses som de er' } });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse for image/png'), {
      target: { value: 'kort' },
    });
    expect(within(dialog).getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(within(dialog).getByText('1 av 2 mangler begrunnelse')).toBeTruthy();

    fireEvent.click(publishButton(dialog));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published(calls)).toEqual([]);
  });

  it('publish succeeds with a reason for each unmasked type and records them on the risk assessment', async () => {
    const { calls, fetch } = platform({ unmasked: [textUse, imageUse] });
    const dialog = await openPublish(fetch);
    fireEvent.change(await within(dialog).findByLabelText('Begrunnelse for text/plain'), {
      target: { value: 'Innsendte skjemaer må leses som de er' },
    });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse for image/png'), {
      target: { value: 'Skannede vedlegg uten tekstlag' },
    });
    await waitFor(() =>
      expect(publishButton(dialog).getAttribute('aria-disabled')).not.toBe('true'),
    );
    fireEvent.click(publishButton(dialog));
    await waitFor(() => expect(published(calls)).toHaveLength(1));
    const body = published(calls)[0]?.body as { definition: ServiceDefinition };
    expect(body.definition.spec.riskConfirmation?.unmaskedInput).toEqual([
      { mediaType: 'text/plain', reason: 'Innsendte skjemaer må leses som de er' },
      { mediaType: 'image/png', reason: 'Skannede vedlegg uten tekstlag' },
    ]);
    expect(body.definition.spec.riskConfirmation).not.toHaveProperty('by');
  });

  it('the unmasked input control does not show when nothing goes unmasked', async () => {
    const { calls, fetch } = platform();
    const dialog = await openPublish(fetch);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/validate'))).toBe(true));
    await waitFor(() =>
      expect(publishButton(dialog).getAttribute('aria-disabled')).not.toBe('true'),
    );
    expect(within(dialog).queryByText('Lyd, bilder og filer som sendes umaskert')).toBeNull();
    expect(within(dialog).queryByText('Umaskede typer begrunnet')).toBeNull();
  });

  it('a refusal for unmasked input shows its message on the reason field and focuses it', async () => {
    const { fetch } = platform({
      publish: () =>
        Response.json(
          {
            title: 'Invalid definition',
            status: 422,
            errors: [
              {
                path: 'spec.strategy.config.flow',
                message:
                  "step extract in uttrekk@1: example/extract@1 takes text/plain input, which cannot be masked; the service's risk assessment must record unmasked input of text/plain with a reason",
              },
            ],
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
    });
    const dialog = await openPublish(fetch);
    await waitFor(() =>
      expect(publishButton(dialog).getAttribute('aria-disabled')).not.toBe('true'),
    );
    fireEvent.click(publishButton(dialog));
    const field = await within(dialog).findByLabelText('Begrunnelse for text/plain');
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(
      within(dialog).getAllByText(
        'Tekstfiler (text/plain) kan ikke maskeres, og plattformen fant ingen begrunnelse for det.',
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('the published version', () => {
  const tenant = '991825827';
  const consented: ServiceDefinition = {
    apiVersion: 'genai/v1',
    kind: 'Service',
    metadata: { tenant, id: 'uttrekk', name: 'Uttrekk' },
    spec: {
      purpose: 'Hent ut felter',
      riskClass: 'minimal',
      riskConfirmation: {
        by: 'employee:ansattporten:kari',
        at: '2026-11-10T09:30:00Z',
        reasons: [],
        riskClass: 'minimal',
        unmaskedInput: [{ mediaType: 'text/plain', reason: 'Innsendte skjemaer må leses' }],
      },
      input: { accepts: ['text/plain'] },
      output: { kind: 'answer' },
      strategy: { id: 'step-flow', version: 1, config: { flow: 'uttrekk@1' } },
      model: { primary: 'foundry-openai/gpt-4.1-mini', residency: 'global' },
    },
  } as ServiceDefinition;

  it('shows who recorded the unmasked input, when and why', async () => {
    const api = {
      usage: async () => ({ byService: [] }),
      tasks: async () => ({ data: [] }),
    } as unknown as ApiClient;
    const latest = {
      kind: 'Service',
      tenant,
      id: 'uttrekk',
      version: 1,
      publishedBy: 'employee:ansattporten:kari',
      publishedByName: 'Kari Nordmann',
      publishedAt: '2026-11-10T09:30:00Z',
      reason: 'Første versjon',
      definition: consented,
      files: {},
    } as unknown as PublishedDefinition;
    render(
      <OverviewSection
        api={api}
        tenant={tenant}
        id="uttrekk"
        definition={consented}
        versions={[]}
        published={latest}
      />,
    );
    expect(await screen.findByText('Sendes umaskert')).toBeTruthy();
    expect(screen.getByText('Tekstfiler (text/plain): Innsendte skjemaer må leses')).toBeTruthy();
    expect(screen.getByText(/^Bekreftet av Kari Nordmann, /)).toBeTruthy();
  });
});

describe('reading a refusal', () => {
  it('reads the unmasked refusal in linear time on a long adversarial message', () => {
    const message = `step ${'a: '.repeat(50_000)}`;
    const started = performance.now();
    expect(refusedUnmaskedInput([{ message }])).toEqual([]);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
