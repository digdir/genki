// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatKr } from '../../data/playground';
import { translator } from '../../i18n';
import { PlaygroundPanel } from './PlaygroundPanel';

document.getAnimations ??= () => [];

afterEach(cleanup);

describe('the playground in English', () => {
  it('shows the panel in English', async () => {
    render(inEnglish(<PlaygroundPanel layout="full" tenantName="Testetaten" />));
    expect(await screen.findByRole('button', { name: /compare/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sammenlign/i })).toBeNull();
  });

  it('formats prices and the unpriced state for English', () => {
    expect(formatKr(null, undefined, translator('en'))).toBe('Not priced');
  });
});
