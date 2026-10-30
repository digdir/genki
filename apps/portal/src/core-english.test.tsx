// @vitest-environment jsdom
import { createFormat } from '@genai/i18n';
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockAnsattporten } from './auth';
import { ChangeLogged, changedWhen } from './components/ChangeLogged';
import { reasonProblem } from './components/ReasonField';
import { actorLabel, formatDateTime, formatKroner, formatSeconds, statusOf } from './format';
import { translator } from './i18n';
import { exampleOrganisations, mockFetch } from './mock';
import { NoAccess } from './screens/NoAccess';
import { PublicDataHandling } from './screens/DataHandling';
import { Startside } from './screens/Startside';
import { requestProblems } from './screens/Unregistered';
import { needsRight, rightLabel } from './Shell';
import { expectAccessible } from './test-utils';

document.getAnimations ??= () => [];

afterEach(cleanup);

const en = translator('en');
const enFormat = createFormat('en');

describe('shared helpers in English', () => {
  it('words statuses, actors, rights and reasons in English', () => {
    expect(statusOf('failed', en)).toEqual({ text: 'Failed', color: 'danger' });
    expect(actorLabel('operator:ola', en)).toBe('Digdir');
    expect(actorLabel('user:kari', en)).toBe('Employee at the organisation');
    expect(rightLabel(en, 'manage-services')).toBe('Manage services');
    expect(needsRight('view-usage', en)).toBe('You need the right "See usage and cost".');
    expect(reasonProblem('short', en)).toBe('Write a reason of at least 10 characters.');
    expect(formatKroner(null, enFormat, en)).toBe('Not priced');
    expect(formatSeconds(1.5, enFormat, en)).toBe('1.5 s');
  });

  it('keeps bokmål output unchanged by default', () => {
    expect(statusOf('failed').text).toBe('Feilet');
    expect(needsRight('view-usage')).toBe('Du trenger rettigheten «Se forbruk og kostnad».');
    expect(formatDateTime('2026-10-03T07:09:00Z')).toBe('3. okt. 2026, 09:09');
    expect(formatKroner(1_234_500_000)).toBe('1\u00a0234,50\u00a0kr');
  });

  it('writes when a change was made in English', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    expect(changedWhen(new Date('2026-10-07T10:00:00Z'), now, enFormat, en)).toBe('today at 12:00');
    expect(changedWhen(new Date('2026-10-03T07:09:00Z'), now, enFormat, en)).toBe(
      '3 October 2026, 09:09',
    );
  });

  it('renders the logged change in English', () => {
    render(
      inEnglish(
        <ChangeLogged
          by="Kari Nordmann"
          at="2026-10-07T12:05:00Z"
          reason="Stricter sources"
          now={new Date('2026-10-07T12:30:00Z')}
        >
          The block is in use.
        </ChangeLogged>,
      ),
    );
    expect(screen.getByRole('status').textContent).toBe(
      'The block is in use. Changed by Kari Nordmann today at 14:05: "Stricter sources". Logged.',
    );
  });

  it('explains registration form problems in English', () => {
    expect(
      requestProblems(
        {
          orgName: '',
          contactName: 'Kari',
          contactEmail: 'x',
          purpose: 'short',
          acceptedTerms: false,
        },
        en,
      ),
    ).toEqual({
      orgName: 'Write the name of the organisation.',
      contactEmail:
        'The email address does not look right. It should look like this: name@organisation.example.no.',
      purpose: 'Write what you want to use the platform for, with at least 20 characters.',
      acceptedTerms:
        'Tick the box to say you have read the draft terms and data processing agreement.',
    });
  });
});

describe('screens in English', () => {
  it('presents the front page in English', () => {
    render(inEnglish(<Startside onLogin={() => undefined} busy={false} failed />));
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Generative AI for public organisations, run by Digdir',
      }),
    ).toBeTruthy();
    const anchors = screen.getByRole('navigation', { name: 'On this page' });
    expect(
      within(anchors)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Shared services', 'Examples', 'Price and terms', 'Data', 'Documentation']);
    expect(screen.getByRole('alert').textContent).toBe('Sign-in failed. Try again.');
    expect(screen.getByRole('link', { name: 'See prices' })).toBeTruthy();
    expect(document.body.textContent).toContain('Today the models run in Azure');
    expectAccessible();
  });

  it('shows the data handling page in English', () => {
    render(inEnglish(<PublicDataHandling />));
    expect(screen.getByRole('heading', { level: 1, name: 'How data is handled' })).toBeTruthy();
    expect(document.body.textContent).toContain('Digdir never creates API keys');
  });

  it('tells a person without rights what to ask for', () => {
    render(inEnglish(<NoAccess name="Kari Nordmann" organisation="Testetaten" />));
    expect(
      screen.getByRole('heading', { level: 1, name: 'You do not have access yet' }),
    ).toBeTruthy();
    expect(screen.getByRole('textbox').textContent).toContain('give me the right "Use services"');
    expect(screen.getByText('Manage datasets')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(screen.getByText('Checking Altinn')).toBeTruthy();
  });

  it('shows the signed-in portal shell and overview in English', async () => {
    const auth = mockAnsattporten({ name: 'Kari Nordmann', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={mockFetch()} languages={['en-GB']} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Main menu' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent)
        .slice(1, 4),
    ).toEqual(['Overview', 'Services', 'Shared services']);
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: 'Latest changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /open user menu/ }));
    expect(screen.getByRole('link', { name: 'Profile' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
  });
});
