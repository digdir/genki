// @vitest-environment jsdom
import { LocaleProvider } from '@genai/i18n/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicErrorBoundary } from './PublicErrorBoundary';

afterEach(cleanup);

const Broken = () => {
  throw new Error('broken page');
};

describe('public error boundary', () => {
  it('shows a heading and a way back instead of a blank page when a public page throws', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <LocaleProvider preference="nb">
        <PublicErrorBoundary>
          <Broken />
        </PublicErrorBoundary>
      </LocaleProvider>,
    );
    quiet.mockRestore();

    expect(screen.getByRole('heading', { level: 1, name: 'Noe gikk galt' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Last inn forsiden på nytt' })).toBeTruthy();
  });
});
