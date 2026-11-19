// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DataHandlingContent } from './DataHandling';

afterEach(cleanup);

describe('the data handling page', () => {
  it('lists a model under the AI gateway when the API says it goes through it, whoever runs it', () => {
    render(
      <DataHandlingContent
        models={{
          status: 'ready',
          data: [
            {
              id: 'gw/sigma2-borealis-27b',
              name: 'Borealis 27B',
              residency: 'norway',
              capabilities: [],
              operator: { name: 'Sigma2' },
              gateway: true,
            } as never,
          ],
        }}
      />,
    );
    expect(screen.getByText('KI-gatewayen i Norge')).toBeTruthy();
    expect(screen.getByText('Kjører Borealis 27B. Data forlater ikke Norge.')).toBeTruthy();
  });
});
