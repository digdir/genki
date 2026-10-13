// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { mockFetch } from '../../mock';
import '../../test-utils';
import { translator } from '../../i18n';
import { ServiceChannels } from './Channels';
import { ServiceNav } from './ServiceNav';
import { describeProblem } from './publish';
import { sectionLabels } from './sections';

afterEach(cleanup);

const api = createApiClient({ baseUrl: '/api', fetch: mockFetch(), token: () => 'test' });

describe('service pages in English', () => {
  it('names the navigation and sections in English', () => {
    render(
      inEnglish(
        <ServiceNav id="klarsprak" sections={['overview', 'channels', 'log']} current="log" />,
      ),
    );
    const nav = screen.getByRole('navigation', { name: 'Service' });
    expect(within(nav).getByText('Overview')).toBeTruthy();
    expect(within(nav).getByText('Channels and frontends')).toBeTruthy();
    expect(within(nav).getByText('Log')).toBeTruthy();
  });

  it('labels every section in both languages', () => {
    const en = translator('en');
    for (const [section, key] of Object.entries(sectionLabels))
      if (section !== 'test') expect(en(key)).not.toBe(translator('nb')(key));
  });

  it('describes publish problems in English', () => {
    const t = translator('en');
    expect(describeProblem({ path: 'spec.model', message: 'Required' }, t)).toEqual({
      section: 'Model',
      message: 'This field is required.',
    });
    expect(describeProblem({ path: 'spec.guardrails', message: 'x' }, t).section).toBe(
      'Guardrails',
    );
  });

  it('lists frontends and the registration form in English', async () => {
    render(
      inEnglish(
        <ServiceChannels
          api={api}
          tenant="999888777"
          service="rapportassistenten"
          apiBase="https://api.example.no"
        />,
      ),
    );
    const cards = await screen.findByRole('list', { name: 'Frontends' });
    expect(within(cards).getByText('Browser with sign-in')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Endpoints' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Register frontend' }));
    expect(screen.getByLabelText('Name')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    expect(
      (await screen.findAllByText('The name must contain at least one letter or number.')).length,
    ).toBeGreaterThan(0);
  });

  it('shows API keys in English', async () => {
    render(
      inEnglish(
        <ServiceChannels
          api={api}
          tenant="999888777"
          service="rapportassistenten"
          apiBase="https://api.example.no"
        />,
      ),
    );
    expect(await screen.findByRole('heading', { name: 'API keys for the service' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    expect(screen.getByText('Settings that can be overridden per call')).toBeTruthy();
  });
});
