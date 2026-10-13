// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { defineCatalogue, type Translation } from './index.js';
import {
  defineTranslations,
  inEnglish,
  LanguageChoice,
  LocaleProvider,
  useFormat,
  useLocale,
} from './react.js';

const nb = defineCatalogue({
  page: { title: 'Velkommen, {name}', terms: 'Les <link>vilkårene</link> før du starter.' },
});
const en = {
  page: { title: 'Welcome, {name}', terms: 'Read the <link>terms</link> before you start.' },
} satisfies Translation<typeof nb>;
const { useT } = defineTranslations({ nb, en });

const Page = () => {
  const t = useT();
  const f = useFormat();
  const { locale } = useLocale();
  return (
    <main>
      <h1>{t('page.title', { name: 'Kari' })}</h1>
      <p>{t.rich('page.terms', { link: (c) => <a href="/terms">{c}</a> })}</p>
      <p data-testid="date">{f.date(new Date('2026-10-07T10:00:00Z'))}</p>
      <p data-testid="locale">{locale}</p>
      <LanguageChoice />
    </main>
  );
};

afterEach(cleanup);

describe('React i18n', () => {
  it('renders bokmål by default', () => {
    render(<Page />);
    expect(screen.getByRole('heading', { name: 'Velkommen, Kari' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'vilkårene' }).getAttribute('href')).toBe('/terms');
  });

  it('renders English through the test helper and marks the document', () => {
    render(inEnglish(<Page />));
    expect(screen.getByRole('heading', { name: 'Welcome, Kari' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'terms' })).toBeTruthy();
    expect(screen.getByTestId('date').textContent).toBe('7 October 2026');
    expect(document.documentElement.lang).toBe('en');
  });

  it('follows the detected language until the person chooses one', () => {
    const chosen: (string | null)[] = [];
    render(
      <LocaleProvider detected={['en-US', 'en']} onPreferenceChange={(p) => chosen.push(p)}>
        <Page />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');
    fireEvent.click(screen.getByRole('radio', { name: 'Norsk bokmål' }));
    expect(screen.getByTestId('locale').textContent).toBe('nb');
    expect(screen.getByRole('group', { name: 'Språk / Language' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Som nettleseren' }));
    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(chosen).toEqual(['nb', null]);
  });
});
