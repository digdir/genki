// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { InLocale } from '@genai/i18n/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisplayLevelChoice, ExperimentSwitches, type SettingsExperiment } from './Choices.js';
import { displayLevels, isDisplayLevel, type DisplayLevel } from './displayLevel.js';
import { Settings, type SettingsProps } from './Settings.js';

afterEach(cleanup);

const draw = (props: Partial<SettingsProps> = {}) =>
  render(<Settings onColorSchemeChange={() => {}} {...props} />);

const regions = () =>
  screen.getAllByRole('region').map((region) => region.getAttribute('aria-labelledby'));
const regionNames = () =>
  screen
    .getAllByRole('region')
    .map((region) => region.querySelector('h1, h2, h3, h4, h5, h6')?.textContent);

const experiments: SettingsExperiment[] = [
  {
    id: 'year-ranges',
    title: 'Årsfilter med perioder',
    description: 'Skriv et år eller en periode, som 2021 eller 2023–2028.',
    on: false,
    href: 'https://github.com/digdir/kunnskapsassistenten/issues/115',
    hrefLabel: 'Sak 115',
  },
  { id: 'compact-filter-chips', title: 'Samlede merkelapper i filteret', on: true },
];

describe('how much an answer shows', () => {
  it('is a section «Svar» with «Standard» and «Detaljert», each with what it shows', () => {
    draw({ onDisplayLevelChange: () => {} });
    const section = screen.getByRole('region', { name: 'Svar' });
    const group = within(section).getByRole('group', {
      name: 'Hvor mye skal svaret vise om hvordan det ble til?',
    });
    const standard = within(group).getByRole('radio', { name: 'Standard' });
    const detailed = within(group).getByRole('radio', { name: 'Detaljert' });
    expect(standard.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      document.getElementById(detailed.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('søkestrengene for hvert steg');
  });

  it('stands on «Standard» until the host says otherwise, and reports the choice', () => {
    const onDisplayLevelChange = vi.fn<(level: DisplayLevel) => void>();
    draw({ onDisplayLevelChange });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Standard' }).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Detaljert' }));
    expect(onDisplayLevelChange).toHaveBeenCalledWith('detailed');
  });

  it('shows the host’s value, not the click, and treats a value it does not know as «Standard»', () => {
    const onChange = vi.fn();
    const { rerender } = render(<DisplayLevelChoice value="detailed" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Standard' }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Detaljert' }).checked).toBe(true);
    rerender(<DisplayLevelChoice value={'all' as DisplayLevel} onChange={onChange} />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Standard' }).checked).toBe(true);
  });

  it('is not drawn when the host does not take the choice', () => {
    draw();
    expect(screen.queryByRole('region', { name: 'Svar' })).toBeNull();
  });

  it('knows its two levels, and a stored value that is not one is no choice', () => {
    expect(displayLevels).toEqual(['standard', 'detailed']);
    for (const value of ['detaljert', 'all', '', null, undefined])
      expect(isDisplayLevel(value)).toBe(false);
  });
});

describe('the experiments', () => {
  it('are a section «Eksperimenter» that says all are off until turned on', () => {
    draw({ experiments, onExperimentChange: () => {} });
    const section = screen.getByRole('region', { name: 'Eksperimenter' });
    expect(within(section).getByText(/Alle er av til du slår dem på/)).toBeTruthy();
  });

  it('give each trial a switch, on as the host says', () => {
    draw({ experiments, onExperimentChange: () => {} });
    const years = screen.getByRole<HTMLInputElement>('switch', { name: 'Årsfilter med perioder' });
    const chips = screen.getByRole<HTMLInputElement>('switch', {
      name: 'Samlede merkelapper i filteret',
    });
    expect(years.checked).toBe(false);
    expect(chips.checked).toBe(true);
  });

  it('report a switch turned on or off by the trial’s id', () => {
    const onExperimentChange = vi.fn();
    draw({ experiments, onExperimentChange });
    fireEvent.click(screen.getByRole('switch', { name: 'Årsfilter med perioder' }));
    expect(onExperimentChange).toHaveBeenLastCalledWith('year-ranges', true);
    fireEvent.click(screen.getByRole('switch', { name: 'Samlede merkelapper i filteret' }));
    expect(onExperimentChange).toHaveBeenLastCalledWith('compact-filter-chips', false);
  });

  it('link each trial to where it is discussed, in a new tab that is said in words', () => {
    render(<ExperimentSwitches experiments={experiments} onChange={() => {}} />);
    // jsdom drops the space that opens the hidden words, which a browser keeps.
    const link = screen.getByRole('link', { name: /^Sak 115 ?\(åpnes i ny fane\)$/ });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/digdir/kunnskapsassistenten/issues/115',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it('say «Les mer» for a link the host gives no text', () => {
    render(
      <ExperimentSwitches
        experiments={[{ id: 'a', title: 'Et forsøk', on: false, href: 'https://example.org' }]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('link', { name: /^Les mer ?\(åpnes i ny fane\)$/ })).toBeTruthy();
  });

  it('are not drawn without trials, or without a host that takes the change', () => {
    draw({ experiments: [], onExperimentChange: () => {} });
    expect(screen.queryByRole('region', { name: 'Eksperimenter' })).toBeNull();
    cleanup();
    draw({ experiments });
    expect(screen.queryByRole('region', { name: 'Eksperimenter' })).toBeNull();
  });
});

describe('the page as a whole', () => {
  it('keeps the colour scheme first, as its main choice, then the answers, the trials and the host’s own', () => {
    draw({
      onDisplayLevelChange: () => {},
      experiments,
      onExperimentChange: () => {},
      children: <section aria-label="Utvikling" />,
    });
    expect(regionNames()).toEqual(['Fargemodus', 'Svar', 'Eksperimenter', undefined]);
    expect(regions()).toHaveLength(4);
  });

  it('ends with the host’s note, such as where the choices are kept', () => {
    const { container } = draw({ note: 'Valgene huskes i denne nettleseren.' });
    const article = container.querySelector('article');
    expect(article?.lastElementChild?.textContent).toBe('Valgene huskes i denne nettleseren.');
  });

  it('speaks English when the person does', () => {
    render(
      <InLocale locale="en">
        <Settings
          onColorSchemeChange={() => {}}
          onDisplayLevelChange={() => {}}
          experiments={experiments}
          onExperimentChange={() => {}}
        />
      </InLocale>,
    );
    expect(screen.getByRole('region', { name: 'Answers' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Detailed' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Experiments' })).toBeTruthy();
  });
});
