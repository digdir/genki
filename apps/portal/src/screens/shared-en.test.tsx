// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../api';
import { sharedCapabilities } from '../data/shared-services';
import type { ScreenProps } from '../screen';
import type { SharedService } from '../types';
import { SharedServices } from './SharedServices';
import { SharedServiceDetail } from './shared/SharedServiceDetail';

document.getAnimations ??= () => [];
afterEach(cleanup);

const service = {
  id: 'summary',
  name: 'Summary',
  purpose: 'Summarises documents',
  version: 1,
  residency: 'norway',
  model: 'aivar/borealis-27b',
  variants: [],
} as unknown as SharedService;

const models = [{ id: 'aivar/borealis-27b', residency: 'norway', capabilities: [] }];

describe('shared services in English', () => {
  it('shows a live service with English labels', async () => {
    const api = {
      sharedServices: () => Promise.resolve([service]),
      listModels: () => Promise.resolve(models),
    } as unknown as ApiClient;
    const props = { api, live: true, route: { segments: ['shared-services'] } } as ScreenProps;
    render(inEnglish(<SharedServices {...props} />));
    expect(await screen.findByRole('heading', { level: 1, name: 'Shared services' })).toBeTruthy();
    expect(screen.getByText('Summarises documents')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try and see details for Summary' })).toBeTruthy();
  });

  it('shows the residency of a live service in English on the detail page', async () => {
    const api = {
      sharedServices: () => Promise.resolve([service]),
      listModels: () => Promise.resolve(models),
    } as unknown as ApiClient;
    const props = {
      api,
      live: true,
      route: { segments: ['shared-services', 'summary'] },
    } as ScreenProps;
    render(inEnglish(<SharedServices {...props} />));
    expect(await screen.findByRole('heading', { level: 1, name: 'Summary' })).toBeTruthy();
    const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
    expect(fact('Where data is processed')?.textContent).toBe('Norway How data is handled');
  });

  it("shows the model's price per 1,000 tokens in English on the card", async () => {
    const priced = [{ ...models[0], price: { inputPerThousand: 0.5, outputPerThousand: 1.25 } }];
    const api = {
      sharedServices: () => Promise.resolve([service]),
      listModels: () => Promise.resolve(priced),
    } as unknown as ApiClient;
    const props = { api, live: true, route: { segments: ['shared-services'] } } as ScreenProps;
    render(inEnglish(<SharedServices {...props} />));
    expect(
      await screen.findByText(
        'Processes data in Norway · 0.5 kr in and 1.25 kr out per 1,000 tokens',
      ),
    ).toBeTruthy();
  });

  it('shows the detail page chrome and validation in English', () => {
    const capability = sharedCapabilities[0] as (typeof sharedCapabilities)[number];
    render(
      inEnglish(
        <SharedServiceDetail
          api={{} as ApiClient}
          tenant="999888777"
          capability={capability}
          publicName="x"
          block={undefined}
          blockId="991825827/klarsprak"
          owner="991825827"
          price="Not calculated"
        />,
      ),
    );
    expect(screen.getByRole('heading', { name: 'Try now' })).toBeTruthy();
    expect(screen.getByText(/of 20,000 characters/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('Paste text or upload a file.')).toBeTruthy();
  });
});
