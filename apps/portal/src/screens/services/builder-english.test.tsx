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
  it('shows the header, meta line and publish dialog in English', async () => {
    render(
      inEnglish(
        <RightsProvider value={['manage-services']}>
          <Builder
            api={api}
            tenant="digdir"
            tenantName="Digdir"
            init={newServiceInit('answers', 'Answer questions')}
            route={{ segments: ['services', 'new'], query: new URLSearchParams() } as never}
            section="setup"
            pane="tjeneste"
            openPublish={false}
          />
        </RightsProvider>,
      ),
    );
    expect(screen.getByText('Not published · saved automatically')).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Publish' })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByText('Publish the service')).toBeTruthy());
    expect(screen.getByText(/Publishing replaces the version in use/)).toBeTruthy();
  });
});
