// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  examplePlaygroundOptions,
  exampleRun,
  formatKr,
  initialSetup,
} from '../../data/playground';
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

  it('names the steps of an example run in English when asked in English', () => {
    const { steps } = exampleRun(
      examplePlaygroundOptions,
      {
        setup: initialSetup(examplePlaygroundOptions, 'free'),
        input: { text: 'Hva sier evalueringene om digital veiledning?' },
      },
      'en',
    );

    expect(steps?.map((s) => s.title)).toContain('Question in the playground');
    expect(steps?.map((s) => s.title)).not.toContain('Spørsmål i prøveområdet');
  });

  it('formats prices and the unpriced state for English', () => {
    expect(formatKr(null, undefined, translator('en'))).toBe('Not priced');
  });
});
