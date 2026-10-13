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
  variants: [],
} as unknown as SharedService;

describe('shared services in English', () => {
  it('shows a live service with English labels', async () => {
    const api = { sharedServices: () => Promise.resolve([service]) } as unknown as ApiClient;
    const props = { api, live: true, route: { segments: ['shared-services'] } } as ScreenProps;
    render(inEnglish(<SharedServices {...props} />));
    expect(await screen.findByRole('heading', { level: 1, name: 'Shared services' })).toBeTruthy();
    expect(screen.getByText('Not measured')).toBeTruthy();
    expect(screen.getByText('Norway')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try and see details for Summary' })).toBeTruthy();
  });

  it('shows the detail page chrome and validation in English', () => {
    const capability = sharedCapabilities[0] as (typeof sharedCapabilities)[number];
    render(
      inEnglish(
        <SharedServiceDetail api={{} as ApiClient} capability={capability} publicName="x" />,
      ),
    );
    expect(screen.getByRole('heading', { name: 'Try now' })).toBeTruthy();
    expect(screen.getByText(/of 20,000 characters/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByText('Paste text or upload a file.')).toBeTruthy();
  });
});
