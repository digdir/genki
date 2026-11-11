// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsExperiment } from './Choices.js';
import { ColorSchemeToggle } from './Settings.js';
import { SettingsMenu, settingsPageIds } from './SettingsMenu.js';
import {
  SettingsAboutYou,
  SettingsBeta,
  SettingsGeneral,
  SettingsPrivacy,
} from './SettingsPages.js';

afterEach(cleanup);

const nothingYet = () => screen.queryByText('Ingen valg her ennå.');
const notice = () => document.querySelector('.uib-settings-page-notice');
const rowTitles = () =>
  [...document.querySelectorAll('.uib-settings-row-title, .uib-settings-row .ds-label')].map(
    (title) => title.textContent,
  );

describe('the settings menu', () => {
  const pages = settingsPageIds.map((id) => ({ id }));

  it('names the four pages in the boards’ order, each with its line under it', () => {
    render(<SettingsMenu onChange={() => {}} pages={pages} value="general" />);
    const list = screen.getByRole('list', { name: 'Sidene i innstillingene' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([
      'GenereltSpråk, svarlengde, utseende',
      'Om degRolle og kontekst',
      'Beta-funksjonerPrøv før de er ferdige',
      'Personvern og dataLagring og sletting',
    ]);
  });

  it('marks the page on screen, and reports the reader’s choice', () => {
    const onChange = vi.fn<(id: string) => void>();
    render(<SettingsMenu onChange={onChange} pages={pages} value="beta" />);
    const current = screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-current'));
    expect(current.map((b) => [b.textContent, b.getAttribute('aria-current')])).toEqual([
      ['Beta-funksjonerPrøv før de er ferdige', 'page'],
    ]);
    fireEvent.click(screen.getByRole('button', { name: /^Om deg/ }));
    expect(onChange).toHaveBeenLastCalledWith('about-you');
  });

  it('draws a badge only for a count over 0, and says the count in words too', () => {
    const { rerender } = render(
      <SettingsMenu onChange={() => {}} pages={[{ id: 'beta', badge: 2 }]} value="general" />,
    );
    const button = screen.getByRole('button', {
      // jsdom trims each element's words; a browser keeps the space.
      name: /^Beta-funksjoner ?\(2 slått på\)$/,
      description: 'Prøv før de er ferdige',
    });
    expect(button.querySelector('.ds-badge')?.getAttribute('aria-hidden')).toBe('true');
    rerender(
      <SettingsMenu onChange={() => {}} pages={[{ id: 'beta', badge: 0 }]} value="general" />,
    );
    expect(document.querySelector('.ds-badge')).toBeNull();
  });

  it('offers «Tilbake til trådene» only with an address, and hands a plain click to the host', () => {
    const { rerender } = render(<SettingsMenu onChange={() => {}} pages={pages} value="general" />);
    expect(screen.queryByRole('link', { name: 'Tilbake til trådene' })).toBeNull();
    const onBack = vi.fn();
    rerender(
      <SettingsMenu
        backHref="/?t=abc"
        onBack={onBack}
        onChange={() => {}}
        pages={pages}
        value="general"
      />,
    );
    const back = screen.getByRole('link', { name: 'Tilbake til trådene' });
    expect(back.getAttribute('href')).toBe('/?t=abc');
    expect(fireEvent.click(back)).toBe(false);
    expect(onBack).toHaveBeenCalledOnce();
    // A click for a new tab is the browser's.
    expect(fireEvent.click(back, { ctrlKey: true })).toBe(true);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('takes a host’s own page by its words', () => {
    render(
      <SettingsMenu
        onChange={() => {}}
        pages={[{ id: 'tilgang', title: 'Tilgang', summary: 'Hvem som ser hva' }]}
        value="tilgang"
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Tilgang', description: 'Hvem som ser hva' }),
    ).toBeTruthy();
  });
});

describe('the colour scheme choice on a settings page', () => {
  it('says «Lyst», «Mørkt» and «Følg systemet» in words alone, at the text’s size, named by its row', () => {
    render(
      <>
        <span id="row">Utseende</span>
        <ColorSchemeToggle labelledBy="row" look="full" onChange={() => {}} value="auto" />
      </>,
    );
    const group = screen.getByRole('group', { name: 'Utseende' });
    expect(group.hasAttribute('data-size')).toBe(false);
    const items = within(group).getAllByRole('radio');
    expect(items.map((item) => item.closest('label')?.textContent)).toEqual([
      'Lyst',
      'Mørkt',
      'Følg systemet',
    ]);
    expect(group.querySelector('svg')).toBeNull();
    expect(items.filter((item) => (item as HTMLInputElement).checked)).toHaveLength(1);
  });
});

describe('«Generelt»', () => {
  it('draws only «Utseende» when the colour scheme is all the host can keep, with no info box', () => {
    const onChange = vi.fn();
    render(<SettingsGeneral colorScheme={{ value: 'dark', onChange }} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Generelt' })).toBeTruthy();
    expect(screen.getByText('Språk, hvordan svarene ser ut, og hvor du starter.')).toBeTruthy();
    expect(rowTitles()).toEqual(['Utseende']);
    expect(notice()).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Lyst' }));
    expect(onChange).toHaveBeenLastCalledWith('light');
  });

  it('draws each choice the host can honour in the boards’ order, and the info box with an answer choice', () => {
    const onLength = vi.fn();
    render(
      <SettingsGeneral
        answerLanguage={{ value: 'nb', onChange: () => {} }}
        answerLength={{ value: 'normal', onChange: onLength }}
        colorScheme={{ value: 'auto', onChange: () => {} }}
        openWith={{ value: 'new', onChange: () => {} }}
        textSize={{ value: 'standard', onChange: () => {} }}
      />,
    );
    expect(rowTitles()).toEqual([
      'Språk i svarene',
      'Svarlengde',
      'Når du åpner tjenesten',
      'Utseende',
      'Tekststørrelse',
    ]);
    expect(notice()?.textContent).toContain('Gjelder hele tjenesten.');
    const length = screen.getByRole('group', { name: 'Svarlengde' });
    expect(length.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(within(length).getByRole('radio', { name: 'Utfyllende' }));
    expect(onLength).toHaveBeenLastCalledWith('long');
  });

  it('says there is nothing to choose rather than draw a dead control', () => {
    render(<SettingsGeneral />);
    expect(nothingYet()).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toEqual([]);
  });
});

describe('«Om deg»', () => {
  it('shows the reader’s name and organisation from the sign-in, locked, and promises nothing more', () => {
    render(<SettingsAboutYou name="Kari Marie Nordmann" organisation="Digdir" />);
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: 'Navn' });
    expect(name.value).toBe('Kari Marie Nordmann');
    expect(name.readOnly).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Virksomhet' }).readOnly).toBe(
      true,
    );
    expect(screen.getByText('Fra innloggingen. Kan ikke endres her.')).toBeTruthy();
    // Nothing tailors the answers yet, so neither the line nor the box says it does.
    expect(screen.queryByText(/bruker når den svarer/)).toBeNull();
    expect(notice()).toBeNull();
  });

  it('draws what tailors the answers only with its handler, and the line and box with it', () => {
    const role = vi.fn();
    const onRemove = vi.fn();
    const onForget = vi.fn();
    render(
      <SettingsAboutYou
        memories={{
          groups: [
            {
              title: 'Arbeidet ditt',
              items: [{ id: 'm1', text: 'Jobber med KI.', thread: 'Hindre', when: '2. okt.' }],
            },
          ],
          onForget,
        }}
        note={{ value: '', onChange: () => {} }}
        remember={{ on: true, onChange: () => {} }}
        role={{ value: 'Rådgiver', onChange: role }}
        subjects={{ values: ['Digitalisering'], onAdd: () => {}, onRemove }}
      />,
    );
    expect(screen.getByText('Det assistenten vet om deg, og bruker når den svarer.')).toBeTruthy();
    expect(notice()?.textContent).toContain('Brukes til å tilpasse svarene.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Rolle' }), {
      target: { value: 'Seniorrådgiver' },
    });
    expect(role).toHaveBeenLastCalledWith('Seniorrådgiver');
    fireEvent.click(screen.getByRole('button', { name: 'Fjern Digitalisering' }));
    expect(onRemove).toHaveBeenLastCalledWith('Digitalisering');
    expect(screen.getByRole('switch', { name: 'Husk ting fra tidligere tråder' })).toBeTruthy();
    expect(screen.getByText('Fra tråden «Hindre» · 2. okt.')).toBeTruthy();
    // «Endre» only with its handler; «Glem» named by what it forgets.
    expect(screen.queryByRole('button', { name: /^Endre/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Glem: Jobber med KI.' }));
    expect(onForget).toHaveBeenLastCalledWith('m1');
  });

  it('says there is nothing to choose without a reader', () => {
    render(<SettingsAboutYou />);
    expect(nothingYet()).toBeTruthy();
  });
});

describe('«Beta-funksjoner»', () => {
  const trials = (on: readonly boolean[]): SettingsExperiment[] =>
    on.map((one, i) => ({ id: `t${i}`, title: `Forsøk ${i}`, on: one }));

  it('lists the host’s trials, each a switch, with how many are on and «Slå av alle»', () => {
    const onChange = vi.fn();
    const onAllOff = vi.fn();
    render(
      <SettingsBeta
        experiments={trials([true, false, true])}
        onAllOff={onAllOff}
        onExperimentChange={onChange}
      />,
    );
    expect(document.querySelector('.uib-settings-count')?.textContent).toContain('2 av 3 slått på');
    expect(notice()?.textContent).toContain('Ting vi tester.');
    const switches = screen.getAllByRole<HTMLInputElement>('switch');
    expect(switches.map((one) => one.checked)).toEqual([true, false, true]);
    fireEvent.click(screen.getByRole('switch', { name: 'Forsøk 1' }));
    expect(onChange).toHaveBeenLastCalledWith('t1', true);
    fireEvent.click(screen.getByRole('button', { name: 'Slå av alle' }));
    expect(onAllOff).toHaveBeenCalledOnce();
  });

  it('offers «Slå av alle» only while one is on', () => {
    render(
      <SettingsBeta
        experiments={trials([false, false])}
        onAllOff={() => {}}
        onExperimentChange={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Slå av alle' })).toBeNull();
  });

  it('asks for feedback only where the host has somewhere to send it', () => {
    const { rerender } = render(<SettingsBeta />);
    expect(screen.queryByText('Si hva du synes')).toBeNull();
    expect(nothingYet()).toBeTruthy();
    rerender(<SettingsBeta feedback={{ href: '/tilbakemelding' }} />);
    expect(screen.getByRole('heading', { name: 'Si hva du synes' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gi tilbakemelding' }).getAttribute('href')).toBe(
      '/tilbakemelding',
    );
  });
});

describe('«Personvern og data»', () => {
  it('says there is nothing to choose while the service keeps no such choice', () => {
    render(<SettingsPrivacy corpus="Kudos" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Personvern og data' })).toBeTruthy();
    expect(nothingYet()).toBeTruthy();
    expect(notice()).toBeNull();
  });

  it('draws each part the host can honour, and the box names the collection', () => {
    const keep = vi.fn();
    const stop = vi.fn();
    const clear = vi.fn();
    render(
      <SettingsPrivacy
        clearHistory={{ onClear: clear }}
        corpus="Kudos"
        download={{ href: '/eksport.zip' }}
        improve={{ on: false, onChange: () => {} }}
        keepThreads={{ value: 60, onChange: keep }}
        shared={{
          threads: [{ id: 's1', title: 'KI i årsrapportene', detail: 'Delt med lenke' }],
          onStopSharing: stop,
        }}
      />,
    );
    expect(notice()?.textContent).toContain('Dokumentene i Kudos er offentlige.');
    const days = screen.getByRole('group', { name: 'Lagre tråder' });
    expect(within(days).getByRole<HTMLInputElement>('radio', { name: '60 dager' }).checked).toBe(
      true,
    );
    fireEvent.click(within(days).getByRole('radio', { name: '90 dager' }));
    expect(keep).toHaveBeenLastCalledWith(90);
    fireEvent.click(screen.getByRole('button', { name: 'Slutt å dele: KI i årsrapportene' }));
    expect(stop).toHaveBeenLastCalledWith('s1');
    expect(screen.getByRole('link', { name: 'Last ned' }).getAttribute('href')).toBe(
      '/eksport.zip',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Slett historikk' }));
    expect(clear).toHaveBeenCalledOnce();
  });
});
