// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PublishSummary } from './PublishSummary';

afterEach(cleanup);

const summary = (testEdition: boolean) =>
  render(
    <PublishSummary
      tenantName="Testetaten"
      currentVersion={7}
      nextVersion={8}
      changes={[]}
      updates={[]}
      facts={[]}
      gates={[{ name: 'Treffsikkerhet', value: '0,61', passed: false }]}
      apiCall={{
        action: 'Publiser',
        method: 'POST',
        path: '/api/definitions',
        right: 'manage-services',
      }}
      onPublish={() => undefined}
      {...(testEdition ? { onPublishToTest: () => undefined } : {})}
    />,
  );

describe('PublishSummary', () => {
  it('says a test edition can still be published when a quality requirement is not met', () => {
    summary(true);
    expect(screen.getByText(/Du kan fortsatt publisere som testutgave\.$/)).toBeTruthy();
  });

  it('promises no test edition where none can be published', () => {
    summary(false);
    expect(screen.getByText(/krav til kvalitet er ikke oppfylt/)).toBeTruthy();
    expect(screen.queryByText(/publisere som testutgave/)).toBeNull();
  });
});
