// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { mockFetch } from '../../mock';
import '../../test-utils';
import { RightsProvider } from '../../Shell';
import { Builder, newServiceInit } from './Builder';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  document.getAnimations ??= () => [];
});

afterEach(cleanup);

const api = createApiClient({ baseUrl: '/api', fetch: mockFetch(), token: () => 'test' });

describe('the builder in English', () => {
  const builder = (section: 'setup' | 'publish') => (
    <RightsProvider value={['manage-services']}>
      <Builder
        api={api}
        tenant="digdir"
        tenantName="Digdir"
        init={newServiceInit('answers', 'Answer questions')}
        route={{ segments: ['services', 'new'], query: new URLSearchParams() } as never}
        section={section}
        pane="tjeneste"
        openPublish={false}
      />
    </RightsProvider>
  );

  it('shows the header and meta line in English, and Publish opens the publish page', () => {
    render(inEnglish(builder('setup')));
    expect(screen.getByText('Not published · saved automatically')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Publish' })[0] as HTMLElement);
    expect(window.location.hash).toBe('#/services/new/publish');
  });

  it('shows the publish page in English, with a way back to the service', async () => {
    render(inEnglish(builder('publish')));
    await waitFor(() => expect(screen.getByText('Publish the service')).toBeTruthy());
    expect(screen.getByText(/Publishing replaces the version in use/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the service' })).toBeTruthy();
  });
});
