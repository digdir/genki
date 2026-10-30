// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exampleTemplate } from '../../data/services';
import { SetupTab, webAddress, type SectionId } from './SetupTab';

document.getAnimations ??= () => [];

afterEach(cleanup);

const noop = () => undefined;

const setup = (continuous: boolean, onAsk?: (question: string) => void, sections?: SectionId[]) =>
  render(
    <SetupTab
      serviceId="new"
      definition={exampleTemplate('answers', 'Ny tjeneste')}
      patch={noop}
      onRename={noop}
      open={{}}
      onToggle={noop}
      highlight=""
      fromAi={{}}
      prohibited={{}}
      onProhibited={noop}
      riskConfirmed={false}
      onConfirmRisk={noop}
      narrow={false}
      instructionsUnderPurpose={continuous}
      safetyTogether={continuous}
      sourcesTogether={continuous}
      continuous={continuous}
      onAsk={onAsk}
      apart={!!sections}
      {...(sections ? { sections } : {})}
    />,
  );

describe('the setup of a new service', () => {
  it('is one form with every part open and a plain heading for each', () => {
    setup(true);
    expect(screen.getByRole('heading', { level: 2, name: 'Formål og målgruppe' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Sikkerhet og personvern' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /^Formål/ })).toBeTruthy();
    for (const heading of screen.getAllByRole('heading', { level: 2 }))
      expect(within(heading).queryByRole('button')).toBeNull();
  });

  it('asks the assistant the question under the field it belongs to', () => {
    const onAsk = vi.fn();
    setup(true, onAsk);
    const purpose = screen.getByRole('heading', { level: 2, name: 'Formål og målgruppe' });
    const part = purpose.closest('section') ?? document.body;
    fireEvent.click(within(part).getByRole('button', { name: 'Hva skal brukerne oppnå?' }));
    expect(onAsk).toHaveBeenCalledWith('Hva skal brukerne oppnå?');
    expect(screen.getByRole('button', { name: 'Hvilke kilder er relevante?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hva skal brukeren sitte igjen med?' })).toBeTruthy();
  });

  it('shows no questions when there is no assistant to ask', () => {
    setup(true);
    expect(screen.queryByRole('button', { name: 'Hva skal brukerne oppnå?' })).toBeNull();
  });

  it('moves the input form and the topics to refuse to pages of their own', () => {
    setup(true, undefined, ['knowledge', 'guards']);
    expect(screen.queryByRole('heading', { name: 'Slik ser saksbehandleren skjemaet' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Emner tjenesten skal avslå' })).toBeNull();
    cleanup();
    setup(true, undefined, ['inputForm', 'refuse']);
    expect(screen.getByRole('heading', { level: 2, name: 'Skjema for inndata' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Emner tjenesten skal avslå' }),
    ).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Emner tjenesten skal avslå' })).toBeTruthy();
  });

  it('takes the kinds of input out of the sources and lets the owner upload documents there', () => {
    setup(true, undefined, ['knowledge']);
    expect(screen.queryByRole('group', { name: 'Hva går inn?' })).toBeNull();
    expect(screen.queryByRole('switch', { name: /Dokumenter brukeren gir/ })).toBeNull();
    const upload = screen.getByLabelText('Egne dokumenter');
    const file = new File(['x'], 'retningslinjer.pdf', { type: 'application/pdf' });
    fireEvent.change(upload, { target: { files: [file] } });
    expect(screen.getByText('retningslinjer.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fjern retningslinjer.pdf' }));
    expect(screen.queryByText('retningslinjer.pdf')).toBeNull();
    cleanup();
    setup(true, undefined, ['inputKinds']);
    expect(screen.getByRole('heading', { level: 2, name: 'Inndata' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Hva går inn?' })).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: /Dokumenter brukeren gir ved kjøring/ }),
    ).toBeTruthy();
  });

  it('adds web pages as sources and turns away what is not a web address', () => {
    setup(true, undefined, ['knowledge']);
    const field = screen.getByRole('textbox', { name: 'Nettsider' });
    fireEvent.change(field, { target: { value: 'ikke en adresse' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Legg til' })[0] ?? field);
    expect(screen.getByText(/Skriv en nettadresse/)).toBeTruthy();
    fireEvent.change(field, { target: { value: 'www.regjeringen.no/no/tema' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText('https://www.regjeringen.no/no/tema')).toBeTruthy();
    expect(webAddress('ftp://example.no')).toBeUndefined();
  });

  it('always shows the sources under the answer, with no switch to turn them off', () => {
    setup(true, undefined, ['result']);
    expect(screen.queryByRole('switch', { name: 'Vis kilder under svaret' })).toBeNull();
    cleanup();
    setup(true);
    expect(
      screen.getAllByRole('switch', { name: 'Vis kilder under svaret' }).length,
    ).toBeGreaterThan(0);
  });

  it('keeps the parts that open and close for a published service', () => {
    setup(false);
    const heading = screen.getByRole('heading', { level: 2, name: /^Formål og målgruppe/ });
    expect(within(heading).getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });
});
