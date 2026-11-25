// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const builder = (detail?: string) =>
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
          detail={detail}
          pane="tjeneste"
          openPublish={false}
        />
      </RightsProvider>,
    ),
  );

describe('the builder in English', () => {
  it('shows the meta line in English, and Publish goes to the publish page', () => {
    window.location.hash = '';
    builder();
    expect(screen.getByText(/^Saved to the test edition at once\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(window.location.hash).toBe('#/services/new/setup/publish');
  });

  it('shows the first publish page in English', () => {
    builder('publish');
    expect(screen.getByRole('heading', { level: 1, name: 'Publish the service' })).toBeTruthy();
    expect(screen.getByText('Users get the service when you publish it.')).toBeTruthy();
    expect(screen.getByText('This is left before you can publish')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recommended: make a test set' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
  });
});
