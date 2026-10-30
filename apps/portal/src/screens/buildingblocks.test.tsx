// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import type { CatalogItem, CatalogProposal } from '../api/building-blocks';
import { exampleProposal } from '../data/building-blocks';
import { mockFetch } from '../mock';
import type { BuildingBlocksMockOptions } from '../mock/building-blocks';
import { translator } from '../i18n';
import { versionText } from './buildingblocks/common';
import { expectAccessible, renderAt } from '../test-utils';

const blocksFetch = (options: BuildingBlocksMockOptions = {}) =>
  mockFetch(undefined, undefined, undefined, undefined, {
    features: { buildingBlocks: options },
  });

const open = async (path: string, options: BuildingBlocksMockOptions = {}) => {
  await renderAt(path, blocksFetch(options));
};

const openAs = async (path: string, actions: string[], options: BuildingBlocksMockOptions = {}) => {
  const auth = mockAnsattporten({
    name: 'Erik Larsen',
    organisations: [{ orgNumber: '999888777', name: 'Testetaten', actions }],
  });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={blocksFetch(options)} />);
};

const openAsViewer = (path: string) => openAs(path, ['Bruke tjenester']);

const proposalSection = async (name = 'Oppslag i Enhetsregisteret') =>
  (await screen.findByRole('heading', { name })).closest('section') as HTMLElement;

const connectorProposal: CatalogProposal = {
  id: 'fagsystem',
  level: 2,
  createdBy: 'assistant',
  forService: { id: 'soknadsuttrekk', name: 'Søknadsuttrekk' },
  createdAt: '2026-10-06T12:30:00Z',
  state: 'pending',
  mapping: [
    { table: 'soknad', becomes: 'document', fields: ['soknad_id → ID', 'belop → Omsøkt beløp'] },
    {
      table: 'saksbehandler_notat',
      becomes: 'excluded',
      reason: 'Interne notater som kan inneholde personopplysninger',
    },
  ],
  permissions: [{ type: 'network', value: 'db.fagsystem.testetaten.example.no, port 5432' }],
  tests: [{ name: 'Testlesing: 50 søknader lest uten feil.', passed: true }],
};

const groupHeadings = () =>
  screen
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent)
    .filter((t) => t !== 'Kunne ikke hente dataene');

const settingFor = (label: string) =>
  screen.getByLabelText(label, { exact: false }).closest('.bb-setting') as HTMLElement;

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => cleanup());

const nbT = translator('nb');

describe('Byggeklosser: liste', () => {
  it('shows the blocks in use grouped by type with tabs, filters and a live count', async () => {
    await open('#/building-blocks');
    expect(await screen.findByRole('heading', { level: 1, name: 'Byggeklosser' })).toBeTruthy();
    expect(await screen.findByRole('tab', { name: 'I bruk hos oss (18)' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Katalog (27)' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Viser 18 byggeklosser som Testetaten bruker',
    );
    const borealis = screen
      .getByRole('link', { name: 'Borealis-27B' })
      .closest('li') as HTMLElement;
    expect(within(borealis).getByText('I bruk')).toBeTruthy();
    expect(within(borealis).getByText('Data i Norge')).toBeTruthy();
    expect(within(borealis).getByText('Oppdatering tilgjengelig')).toBeTruthy();
    expect(
      within(borealis).getByText('Versjon 2.2 · poeng 84 → 87 for Rapportassistenten'),
    ).toBeTruthy();
    expect(within(borealis).getByText('Digdir · versjon 2.1 · Brukes av 5 tjenester')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Legg til egen byggekloss' })).toBeTruthy();
    expectAccessible();
  });

  it('type chips show counts and filter groups', async () => {
    await open('#/building-blocks', { proposals: [] });
    await screen.findByRole('heading', { level: 1, name: 'Byggeklosser' });
    expect(screen.getByRole('radio', { name: 'Modeller 1' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Alle 18' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Katalog (27)' }));
    expect(await screen.findByRole('radio', { name: 'Modeller 4' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Søkemotorer 3' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Modeller 4' }));
    expect(groupHeadings()).toEqual(['Modeller']);
    expect(screen.getByRole('status').textContent).toBe('Viser 4 byggeklosser i katalogen');
    fireEvent.change(screen.getByLabelText('Utgiver'), { target: { value: 'shared' } });
    expect(screen.getByRole('radio', { name: 'Modeller 0' })).toBeTruthy();
    expect(screen.getByText('Ingen byggeklosser passer søket og filtrene.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill filtrene' }));
    fireEvent.change(screen.getByLabelText('Søk etter navn'), { target: { value: 'nynorsk' } });
    expect(groupHeadings()).toEqual(['Fellestjenester']);
  });

  it('shows the empty state with three suggestions when nothing is in use', async () => {
    await open('#/building-blocks', { empty: true });
    expect(
      await screen.findByRole('heading', {
        name: 'Dere har ikke tatt i bruk noen byggeklosser ennå',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Se og ta i bruk Borealis-27B' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Se og ta i bruk Hybridsøk' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Se og ta i bruk Filtrering av personopplysninger' }),
    ).toBeTruthy();
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Se hele katalogen' }));
    expect(await screen.findByRole('link', { name: 'Qwen3.8-27B' })).toBeTruthy();
  });

  it('read-only users see no change buttons and the rights alert', async () => {
    await openAsViewer('#/building-blocks');
    await screen.findByRole('heading', { level: 1, name: 'Byggeklosser' });
    expect(screen.getByText(/Du kan se byggeklossene, men ikke endre dem/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Legg til egen byggekloss' })).toBeNull();
    expectAccessible();
    cleanup();
    await openAsViewer('#/building-blocks/model/qwen');
    await screen.findByRole('heading', { level: 1, name: 'Qwen3.8-27B' });
    expect(screen.getByText(/Du kan se byggeklossen, men ikke endre den/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ta i bruk hos oss' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Legg til i en tjeneste' })).toBeNull();
    expect((screen.getByLabelText('Tidsavbrudd (sekunder)') as HTMLInputElement).disabled).toBe(
      true,
    );
    expectAccessible();
  });
});

describe('Byggeklosser: forslag fra byggeassistenten', () => {
  it('approving a level-3 proposal asks for a reason and needs the register right', async () => {
    await open('#/building-blocks', { proposals: [exampleProposal] });
    const section = (
      await screen.findByRole('heading', { name: 'Oppslag i Enhetsregisteret' })
    ).closest('section') as HTMLElement;
    expect(within(section).getByText('Ikke aktiv før noen godkjenner')).toBeTruthy();
    expect(within(section).getByText('data.brreg.no')).toBeTruthy();
    expect(
      within(section).getByText('9 av 10. Ett nedlagt foretak ble vist som aktivt.'),
    ).toBeTruthy();
    expectAccessible();
    fireEvent.click(within(section).getByRole('button', { name: 'Godkjenn og ta i bruk' }));
    const reason = within(section).getByLabelText('Begrunnelse');
    fireEvent.change(reason, { target: { value: 'for kort' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Bekreft og ta i bruk' }));
    expect(within(section).getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(reason, { target: { value: 'Postsortering trenger oppslaget' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Bekreft og ta i bruk' }));
    expect(
      await screen.findByText(
        /Oppslag i Enhetsregisteret er godkjent og kan brukes i Postsortering/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/«Postsortering trenger oppslaget»\. Logget\./)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Oppslag i Enhetsregisteret' })).toBeNull(),
    );
    expect(await screen.findByRole('link', { name: 'Oppslag i Enhetsregisteret' })).toBeTruthy();
    cleanup();
    await openAs('#/building-blocks', ['Bruke tjenester', 'Administrere tjenester'], {
      proposals: [exampleProposal],
    });
    const other = await proposalSection();
    expect(within(other).queryByRole('button', { name: 'Godkjenn og ta i bruk' })).toBeNull();
    expect(within(other).queryByRole('button', { name: 'Avvis' })).toBeNull();
    expect(
      within(other).getByText(/Du har ikke rettigheten til å registrere byggeklosser/),
    ).toBeTruthy();
  });

  it('a user without the right can send a proposal for approval', async () => {
    await openAs('#/building-blocks', ['Bruke tjenester', 'Administrere tjenester'], {
      proposals: [exampleProposal],
    });
    const section = await proposalSection();
    fireEvent.click(within(section).getByRole('button', { name: 'Send til godkjenning' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Send' }));
    expect(within(section).getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(within(section).getByLabelText('Begrunnelse'), {
      target: { value: 'Postsortering trenger oppslaget' },
    });
    expectAccessible();
    fireEvent.click(within(section).getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Forslaget er sendt til godkjenning/)).toBeTruthy();
    const waiting = await waitFor(async () => {
      const s = await proposalSection();
      expect(within(s).getByText('Sendt til godkjenning')).toBeTruthy();
      return s;
    });
    expect(within(waiting).getByText('Ikke aktiv før noen godkjenner')).toBeTruthy();
    expect(within(waiting).queryByRole('button', { name: 'Send til godkjenning' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Oppslag i Enhetsregisteret' })).toBeNull();
  });

  it('rejecting leaves nothing active', async () => {
    await open('#/building-blocks', { proposals: [exampleProposal] });
    const section = await proposalSection();
    fireEvent.click(within(section).getByRole('button', { name: 'Avvis' }));
    expect(
      await screen.findByText(
        'Forslaget er avvist. Byggeassistenten får beskjed, og ingenting er tatt i bruk.',
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Oppslag i Enhetsregisteret' })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Katalog/ }));
    expect(await screen.findByRole('link', { name: 'Qwen3.8-27B' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Oppslag i Enhetsregisteret' })).toBeNull();
  });

  it('a level-2 connector is approved on the Koblinger page, linked from the list', async () => {
    await openAs('#/building-blocks', ['Bruke tjenester', 'Administrere tjenester'], {
      proposals: [connectorProposal],
    });
    const summary = (
      await screen.findByRole('heading', { name: 'Koblinger til egne databaser' })
    ).closest('section') as HTMLElement;
    expect(within(summary).getByText('1 ny kobling venter på godkjenning.')).toBeTruthy();
    expect(
      within(summary).getByRole('link', { name: 'Se og godkjenn koblingene' }).getAttribute('href'),
    ).toBe('#/building-blocks/connectors');
    expect(screen.queryByRole('heading', { name: 'Kobling for Søknadsuttrekk' })).toBeNull();
  });

  it('without the right, the connector proposal shows what the tables become and can be sent for approval', async () => {
    await openAsViewer('#/building-blocks/connectors');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Koblinger til egne databaser' }),
    ).toBeTruthy();
    cleanup();
    await openAs('#/building-blocks/connectors', ['Bruke tjenester', 'Administrere datasett'], {
      proposals: [connectorProposal],
    });
    const section = await proposalSection('Kobling for Søknadsuttrekk');
    const table = within(section).getByRole('region', { name: 'Hva tabellene blir' });
    expect(within(table).getByRole('row', { name: /soknad Dokument/ })).toBeTruthy();
    expect(within(table).getByText('Tas ikke med')).toBeTruthy();
    expect(within(section).getByText('db.fagsystem.testetaten.example.no, port 5432')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Send til godkjenning' })).toBeTruthy();
    expectAccessible();
  });
});

const withSource: CatalogProposal = {
  ...connectorProposal,
  source: {
    engine: 'postgres',
    host: 'db.fagsystem.testetaten.example.no',
    database: 'fagsystem',
    table: 'saker',
    fields: { id: 'id', title: 'tittel', text: ['sammendrag'] },
    filter: [{ column: 'status', op: 'eq', value: 'avsluttet' }],
  },
};

const approvalForm = async () =>
  (
    await screen.findByRole('heading', { name: 'Godkjenn ny kobling: Kobling for Søknadsuttrekk' })
  ).closest('section') as HTMLElement;

const fillAndApprove = (section: HTMLElement, typed = 'Hemmelig-passord-1') => {
  fireEvent.change(within(section).getByLabelText('Bruker', { exact: false }), {
    target: { value: 'leser' },
  });
  fireEvent.change(within(section).getByLabelText('Passord', { exact: false }), {
    target: { value: typed },
  });
  fireEvent.change(within(section).getByLabelText('Begrunnelse'), {
    target: { value: 'Avsluttede saker til saksinnsyn' },
  });
  fireEvent.click(within(section).getByRole('button', { name: 'Godkjenn og koble til' }));
};

const connectorCard = async (name = 'Kobling for Søknadsuttrekk') =>
  (await screen.findByRole('heading', { level: 3, name })).closest('article') as HTMLElement;

const approveConnector = async () => {
  fillAndApprove(await approvalForm());
  return connectorCard();
};

const waitForSync = { timeout: 4000 };

describe('Byggeklosser: koblinger', () => {
  it('approving a connector asks where the database is and how to log in, then shows its sync status', async () => {
    await open('#/building-blocks/connectors', { proposals: [withSource] });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Koblinger til egne databaser' }),
    ).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Brødsmuler' }).textContent).toContain(
      'Byggeklosser',
    );
    const section = await approvalForm();
    expect(within(section).getByText('Det plattformen skal lese').parentElement?.textContent).toBe(
      'Det plattformen skal leseTabellen saker: tittel fra tittel, tekst fra sammendrag, bare der status er avsluttet. Fyller datasettet «Kobling for Søknadsuttrekk».',
    );
    expect((within(section).getByLabelText('Vert') as HTMLInputElement).value).toBe(
      'db.fagsystem.testetaten.example.no',
    );
    expect(within(section).getByText(/Den sender aldri INSERT, UPDATE eller DELETE/)).toBeTruthy();
    fireEvent.change(within(section).getByLabelText('Begrunnelse'), {
      target: { value: 'Avsluttede saker til saksinnsyn' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Godkjenn og koble til' }));
    expect(within(section).getByText('Skriv brukernavnet plattformen logger på med.')).toBeTruthy();
    expectAccessible();
    expect(within(section).getByLabelText('Passord', { exact: false }).getAttribute('type')).toBe(
      'password',
    );
    fillAndApprove(section);
    expect(
      await screen.findByText(/Koblingen er godkjent. Første synkronisering er i gang/),
    ).toBeTruthy();
    const connector = await connectorCard();
    expect(within(connector).getByText(/^Synkroniserer … Startet/)).toBeTruthy();
    expect(await within(connector).findByText('Tilkoblet', {}, waitForSync)).toBeTruthy();
    expect(within(connector).getByText('50')).toBeTruthy();
    expect(within(connector).getByText('saker i fagsystem')).toBeTruthy();
    expect(within(connector).getByText(/passord lagret i hvelvet/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('Hemmelig-passord-1');
    fireEvent.click(within(connector).getByRole('button', { name: 'Synkroniser nå' }));
    expect(await within(connector).findByText(/^Synkroniserer … Startet/)).toBeTruthy();
    expect(await within(connector).findByText('Tilkoblet', {}, waitForSync)).toBeTruthy();
    expectAccessible();
  });

  it.each([
    [
      { path: 'connection', message: 'the database refused the login', code: 'auth' as const },
      'Feil brukernavn eller passord',
      /Databasen avviste innloggingen for brukeren leser\. Sjekk passordet, og at brukeren finnes i databasen fagsystem\./,
    ],
    [
      {
        path: 'connection',
        message: 'unknown columns',
        code: 'columns' as const,
        missing: ['sammendrag'],
        known: ['id', 'tittel', 'status', 'beskrivelse'],
      },
      'Fant ikke kolonnen sammendrag',
      /Tabellen saker har kolonnene id, tittel, status, beskrivelse\./,
    ],
    [
      { path: 'connection', message: 'the user cannot read the table', code: 'table' as const },
      'Tabellen saker kan ikke leses',
      /Gi brukeren SELECT på tabellen, og prøv igjen\./,
    ],
  ])('shows what failed when the test read fails (%#)', async (checkFailure, title, text) => {
    await open('#/building-blocks/connectors', { proposals: [withSource], checkFailure });
    const section = await approvalForm();
    fillAndApprove(section);
    const alert = (await within(section).findByRole('heading', { name: title })).closest(
      '.ds-alert',
    ) as HTMLElement;
    expect(within(alert).getByText(text)).toBeTruthy();
    expect(
      within(alert).getByText('Ingenting er lagret, og passordet er ikke tatt vare på.'),
    ).toBeTruthy();
    expect(
      (within(section).getByLabelText('Passord', { exact: false }) as HTMLInputElement).value,
    ).toBe('');
    expect(
      screen.queryByRole('heading', { level: 3, name: 'Kobling for Søknadsuttrekk' }),
    ).toBeNull();
    expectAccessible();
  });

  it('says when the host is on a private network Digdir has not opened, or has opened, and warns when TLS is off', async () => {
    await open('#/building-blocks/connectors', {
      proposals: [withSource],
      privateNetworks: ['arkiv.intern'],
    });
    const section = await approvalForm();
    const host = within(section).getByLabelText('Vert');
    fireEvent.change(host, { target: { value: 'fagsystem.intern' } });
    fireEvent.blur(host);
    expect(
      await within(section).findByRole('heading', { name: 'Databasen ligger på et privat nett' }),
    ).toBeTruthy();
    expect(within(section).getByText(/Digdir har ikke åpnet den for Testetaten/)).toBeTruthy();
    expect(within(section).getByText(/Digdir kan åpne adressen/)).toBeTruthy();
    fillAndApprove(section);
    expect(screen.queryByText(/Koblingen er godkjent/)).toBeNull();

    fireEvent.change(host, { target: { value: 'arkiv.intern' } });
    fireEvent.blur(host);
    expect(
      await within(section).findByRole('heading', {
        name: 'Databasen ligger på et privat nett Digdir har åpnet',
      }),
    ).toBeTruthy();

    expect(within(section).queryByText(/Passord og data sendes ukryptert/)).toBeNull();
    fireEvent.change(within(section).getByLabelText('TLS'), { target: { value: 'off' } });
    expect(within(section).getByText(/Passord og data sendes ukryptert/)).toBeTruthy();
    expectAccessible();

    fillAndApprove(section);
    const connector = await connectorCard();
    expect(within(connector).getByText('Ukryptert')).toBeTruthy();
    expect(within(connector).getByText('Privat nett, åpnet av Digdir')).toBeTruthy();
    expect(within(connector).getByText(/TLS ble slått av/)).toBeTruthy();
    expect(
      await screen.findByText(/Private nett Digdir har åpnet for virksomheten: arkiv.intern/),
    ).toBeTruthy();
  });

  it('marks the connector failed with the error when the first sync fails, and offers to try again or change the password', async () => {
    await open('#/building-blocks/connectors', {
      proposals: [withSource],
      firstSyncError: 'Databasen svarte ikke innen 15 sekunder.',
    });
    const connector = await approveConnector();

    expect(await within(connector).findByText('Feilet', {}, waitForSync)).toBeTruthy();
    expect(within(connector).getByText('Databasen svarte ikke innen 15 sekunder.')).toBeTruthy();
    expect(within(connector).getByText(/\(feilet\)$/)).toBeTruthy();
    expectAccessible();

    fireEvent.click(within(connector).getByRole('button', { name: 'Bytt passord' }));
    fireEvent.click(within(connector).getByRole('button', { name: 'Lagre passordet' }));
    expect(within(connector).getByText('Skriv det nye passordet.')).toBeTruthy();
    fireEvent.change(within(connector).getByLabelText('Nytt passord', { exact: false }), {
      target: { value: 'Nytt-passord-2' },
    });
    fireEvent.click(within(connector).getByRole('button', { name: 'Lagre passordet' }));
    expect(await within(connector).findByText(/Passordet er byttet/)).toBeTruthy();

    fireEvent.click(within(connector).getByRole('button', { name: 'Prøv igjen' }));
    expect(await within(connector).findByText('Tilkoblet', {}, waitForSync)).toBeTruthy();
  });

  it('Avbryt folds the form away until you continue', async () => {
    await open('#/building-blocks/connectors', { proposals: [withSource] });
    const section = await approvalForm();
    fireEvent.click(within(section).getByRole('button', { name: 'Avbryt' }));
    expect(
      await screen.findByRole('heading', { name: 'Ny kobling: Kobling for Søknadsuttrekk' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fortsett godkjenningen' }));
    expect(await approvalForm()).toBeTruthy();
  });
});

describe('Byggeklosser: detalj', () => {
  it('the read-only alert names only the right this block needs', async () => {
    await openAsViewer('#/building-blocks/model/qwen');
    await screen.findByRole('heading', { level: 1, name: 'Qwen3.8-27B' });
    expect(screen.getByText(/trenger du rettigheten «Administrere tjenester»\./)).toBeTruthy();
    expect(screen.queryByText(/Administrere datasett/)).toBeNull();
    cleanup();

    await openAsViewer('#/building-blocks/dataset/ds-kudos');
    await screen.findByRole('heading', { level: 1, name: 'Kudos-rapporter' });
    expect(screen.getByText(/trenger du rettigheten «Administrere datasett»\./)).toBeTruthy();
  });

  it('links each test score to the quality page of its service', async () => {
    await open('#/building-blocks/model/borealis');
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    expect(
      screen
        .getByRole('link', { name: 'Se testsettene for Rapportassistenten' })
        .getAttribute('href'),
    ).toBe('#/services/rapportassistenten/quality');
    expect(screen.queryByRole('link', { name: 'Se testsettene' })).toBeNull();
  });

  it('shows dataset versions as versjon N, or ikke versjonert for version 0', () => {
    const dataset = (version: string) => ({ kind: 'dataset', version }) as CatalogItem;
    expect(versionText(nbT, dataset('0'))).toBe('ikke versjonert');
    expect(versionText(nbT, dataset('3'))).toBe('versjon 3');
    expect(versionText(nbT, dataset('Lest inn 5. okt'))).toBe('lest inn 5. okt');
  });

  it('a not-allowed block shows the policy text and who can change it', async () => {
    await open('#/building-blocks/model/gpt5');
    await screen.findByRole('heading', { level: 1, name: 'GPT-5 (OpenAI)' });
    const alert = screen
      .getByText(
        'Ikke tillatt: data behandles utenfor EU/EØS. Digdir kan endre dette i plattforminnstillingene.',
      )
      .closest('.ds-alert') as HTMLElement;
    expect(alert.getAttribute('data-color')).toBe('danger');
    expect(screen.getByText('Ikke tillatt hos oss')).toBeTruthy();
    expect(screen.getAllByText('Data utenfor EU/EØS').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Ta i bruk hos oss' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Be om godkjenning' })).toBeNull();
    expectAccessible();
  });

  it('shows the update table, capabilities, access and versions for a block with an update', async () => {
    await open('#/building-blocks/model/borealis');
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    expect(
      screen.getByRole('heading', { name: 'Versjon 2.2, tilgjengelig fra 6. okt' }),
    ).toBeTruthy();
    const table = screen.getByRole('region', { name: 'Poeng før og etter per tjeneste' });
    expect(within(table).getByText('+3')).toBeTruthy();
    expect(within(table).getByText('−1')).toBeTruthy();
    expect(within(table).getByText('Ingen endring')).toBeTruthy();
    expect(
      within(table).getByRole('link', { name: 'Prøv i utkastet til Rapportassistenten' }),
    ).toBeTruthy();
    expect(screen.getByText('Lagres ikke av modellen')).toBeTruthy();
    expect(await screen.findByText('Versjon 2.0')).toBeTruthy();
    expect(screen.getByText('84 av 100')).toBeTruthy();
    expectAccessible();
  });

  it('the settings form shows inherited, overridden and changed tags', async () => {
    await open('#/building-blocks/model/borealis');
    await screen.findByRole('heading', { name: 'Innstillinger for Testetaten' });
    const temperature = settingFor('Temperatur');
    expect(within(temperature).getByText('Overstyrt for Testetaten')).toBeTruthy();
    expect(within(temperature).getByText('Plattformstandard: 0,2')).toBeTruthy();
    expect(within(settingFor('Lengste svar')).getByText('Arvet fra plattformen')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Lengste svar (tokens)'), {
      target: { value: '5000' },
    });
    expect(within(settingFor('Lengste svar')).getByText('Endret, ikke lagret')).toBeTruthy();
    expect(screen.getByText(/Lengste svar: 4\s000 tokens → 5\s000 tokens/)).toBeTruthy();
    expect(screen.getByText(/Berører 5 tjenester som ikke har egen verdi/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Temperatur'), { target: { value: '3' } });
    expect(screen.getByText('Skriv et tall mellom 0 og 1.')).toBeTruthy();
    expectAccessible();
    fireEvent.change(screen.getByLabelText('Temperatur'), { target: { value: '0,1' } });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Lengre svar for rapporter' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre innstillingene' }));
    expect(
      await screen.findByText(/Innstillingene for Borealis-27B er lagret for Testetaten/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(within(settingFor('Lengste svar')).getByText('Overstyrt for Testetaten')).toBeTruthy(),
    );
  });

  it('Ta i bruk hos oss shows the access list and logs the reason', async () => {
    await open('#/building-blocks/model/qwen');
    await screen.findByRole('heading', { level: 1, name: 'Qwen3.8-27B' });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk hos oss' }));
    expect(
      screen.getByRole('heading', { name: 'Ta i bruk Qwen3.8-27B hos Testetaten' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk' }));
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Raskere uttrekk i Postsortering' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk' }));
    expect(await screen.findByText(/Qwen3.8-27B er tatt i bruk hos Testetaten/)).toBeTruthy();
    expect(await screen.findByText('I bruk')).toBeTruthy();
  });

  it('previews the reason in the body of the adopt call', async () => {
    await open('#/building-blocks/model/qwen');
    await screen.findByRole('heading', { level: 1, name: 'Qwen3.8-27B' });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk hos oss' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Raskere uttrekk i Postsortering' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));
    expect(document.body.textContent).toContain('"reason":"Raskere uttrekk i Postsortering"');
  });

  it('previews the reason in the body of the settings call', async () => {
    await open('#/building-blocks/model/borealis');
    await screen.findByRole('heading', { name: 'Innstillinger for Testetaten' });
    fireEvent.change(screen.getByLabelText('Lengste svar (tokens)'), {
      target: { value: '5000' },
    });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Lengre svar for rapporter' },
    });
    const form = screen.getByRole('button', { name: 'Lagre innstillingene' }).parentElement;
    fireEvent.click(within(form as HTMLElement).getByRole('button', { name: 'Vis API-kall' }));
    expect(document.body.textContent).toContain('"reason":"Lengre svar for rapporter"');
  });

  it('says so when taking a block into use fails, and keeps the dialog open', async () => {
    const inner = blocksFetch();
    const failing: typeof fetch = async (input, init) =>
      String(input).endsWith('/adopt')
        ? new Response(JSON.stringify({ title: 'Internal error', status: 500 }), {
            status: 500,
            headers: { 'content-type': 'application/problem+json' },
          })
        : inner(input, init);
    await renderAt('#/building-blocks/model/qwen', failing);
    await screen.findByRole('heading', { level: 1, name: 'Qwen3.8-27B' });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk hos oss' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Raskere uttrekk i Postsortering' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Vi fikk ikke lagret endringen. Prøv igjen om litt.',
    );
    expect(screen.getByRole('button', { name: 'Ta i bruk' })).toBeTruthy();
  });

  it('a block that needs approval explains who approves and sends the request', async () => {
    await open('#/building-blocks/model/gpt41');
    await screen.findByRole('heading', { level: 1, name: 'GPT-4.1 (Azure OpenAI)' });
    expect(screen.getByText(/Digdir må godkjenne at Testetaten tar modellen i bruk/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Be om godkjenning' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Trenger lange dokumenter' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send forespørselen' }));
    expect(await screen.findByText(/Forespørselen er sendt til Digdir\. Endret av/)).toBeTruthy();
    expect(await screen.findByText('Venter på godkjenning')).toBeTruthy();
  });
});

describe('Byggeklosser: legg til egen', () => {
  it('Registrer byggeklossen stays disabled until the contract test passes and clears on edit', async () => {
    await open('#/building-blocks/new');
    await screen.findByRole('heading', { level: 1, name: 'Legg til egen byggekloss' });
    const register = () => screen.getByRole('button', { name: 'Registrer byggeklossen' });
    expect(register().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    expect(screen.getByText('Skriv et navn.')).toBeTruthy();
    expect(screen.getByText('Skriv en adresse som begynner med https://')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Saksarkivet (MCP)' } });
    fireEvent.change(screen.getByLabelText('Adresse til MCP-serveren'), {
      target: { value: 'https://mcp.saksarkiv.testetaten.example.no' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Manifest', { selector: 'pre' }).textContent).toContain(
        'endpoint: https://mcp.saksarkiv.testetaten.example.no',
      ),
    );
    expect(screen.getByText('mcp.saksarkiv.testetaten.example.no')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    expect(await screen.findByText('Kontrakttest ikke bestått: 2 av 5 feilet')).toBeTruthy();
    expect(
      screen.getByText('2 av 6 verktøy mangler inputSchema: hent_vedlegg, sok_journal.'),
    ).toBeTruthy();
    expect(register().getAttribute('aria-disabled')).toBe('true');
    expectAccessible();

    fireEvent.change(screen.getByLabelText('Adresse til MCP-serveren'), {
      target: { value: 'https://mcp.arkiv.testetaten.example.no' },
    });
    expect(screen.queryByText('Kontrakttest ikke bestått: 2 av 5 feilet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    expect(await screen.findByText('Kontrakttest bestått')).toBeTruthy();
    expect(register().getAttribute('aria-disabled')).toBeNull();

    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Saksarkivet' } });
    expect(screen.queryByText('Kontrakttest bestått')).toBeNull();
    expect(register().getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    await screen.findByText('Kontrakttest bestått');
    fireEvent.click(register());
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse', { exact: false }), {
      target: { value: 'Nytt arkiv for vedtak' },
    });
    fireEvent.click(register());
    expect(
      await screen.findByText(
        /Saksarkivet er registrert og kan brukes i tjenestene til Testetaten/,
      ),
    ).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 1, name: 'Saksarkivet' })).toBeTruthy();
    expect(window.location.hash).toBe('#/building-blocks/tool/saksarkivet');
  });

  it('shows the failed contract tests when registering is refused with 422', async () => {
    const base = blocksFetch();
    const fetch: typeof globalThis.fetch = (input, init) =>
      init?.method === 'POST' && /\/building-blocks$/.test(String(input))
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                type: 'about:blank',
                title: 'Kontrakttesten er ikke bestått',
                status: 422,
                contractTests: [
                  { name: 'Svarer på tools/list', passed: true },
                  { name: 'Alle verktøy har inputSchema', passed: false, reason: 'sok mangler' },
                ],
              }),
              { status: 422, headers: { 'content-type': 'application/problem+json' } },
            ),
          )
        : base(input, init);
    await renderAt('#/building-blocks/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Legg til egen byggekloss' });
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Saksarkivet' } });
    fireEvent.change(screen.getByLabelText('Adresse til MCP-serveren'), {
      target: { value: 'https://mcp.arkiv.testetaten.example.no' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    await screen.findByText('Kontrakttest bestått');
    fireEvent.change(screen.getByLabelText('Begrunnelse', { exact: false }), {
      target: { value: 'Nytt arkiv for vedtak' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registrer byggeklossen' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /^Kontrakttesten feilet da byggeklossen skulle registreres/,
    );
    expect(screen.getByText('sok mangler')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Registrer byggeklossen' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('names the missing right when registering is refused', async () => {
    const base = blocksFetch();
    const fetch: typeof globalThis.fetch = (input, init) =>
      init?.method === 'POST' && /\/building-blocks$/.test(String(input))
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                type: 'about:blank',
                title: 'Du trenger rettigheten «Registrere byggeklosser»',
                status: 403,
              }),
              { status: 403, headers: { 'content-type': 'application/problem+json' } },
            ),
          )
        : base(input, init);
    await renderAt('#/building-blocks/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Legg til egen byggekloss' });
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Saksarkivet' } });
    fireEvent.change(screen.getByLabelText('Adresse til MCP-serveren'), {
      target: { value: 'https://mcp.arkiv.testetaten.example.no' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    await screen.findByText('Kontrakttest bestått');
    fireEvent.change(screen.getByLabelText('Begrunnelse', { exact: false }), {
      target: { value: 'Nytt arkiv for vedtak' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registrer byggeklossen' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Du trenger rettigheten «Registrere byggeklosser»',
    );
  });

  it('shows the run point for extension points and marks undecided types', async () => {
    await open('#/building-blocks/new');
    await screen.findByRole('heading', { level: 1, name: 'Legg til egen byggekloss' });
    expect(screen.getAllByText('API ikke bestemt')).toHaveLength(2);
    expect(
      within(
        screen.getByRole('radio', { name: /Utvidelsespunkt/ }).closest('label') as HTMLElement,
      ).getByText('API ikke bestemt'),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole('radio', { name: /A2A-agent/ }).closest('label') as HTMLElement,
      ).queryByText('API ikke bestemt'),
    ).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Utvidelsespunkt/ }));
    expect(screen.getByLabelText('Når skal den kjøres?')).toBeTruthy();
    expect(screen.getByLabelText('Adresse til endepunktet')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByLabelText('Manifest', { selector: 'pre' }).textContent).toContain(
        'extensionPoint: before_model',
      ),
    );
    expect(screen.getByText('Det punktet gir tilgang til: før modellkall')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Ferdighetspakke/ }));
    expect(screen.queryByLabelText('Innlogging')).toBeNull();
    expect(screen.getByLabelText('Ferdighetspakke (zip med SKILL.md)')).toBeTruthy();
    expectAccessible();
  });

  it('MCP defaults to Ingen, marks Maskinporten unavailable and picks a stored secret', async () => {
    await open('#/building-blocks/new', { secrets: ['saks-api', 'arkiv-nokkel'] });
    await screen.findByRole('heading', { level: 1, name: 'Legg til egen byggekloss' });
    const auth = screen.getByLabelText('Innlogging') as HTMLSelectElement;
    expect(auth.value).toBe('none');
    expect([...auth.options].map((o) => [o.value, o.textContent, o.disabled])).toEqual([
      ['maskinporten', 'Maskinporten (støttes ikke ennå)', true],
      ['api-key', 'API-nøkkel fra hemmelighetene', false],
      ['oauth-client-credentials', 'OAuth-klient (client credentials)', false],
      ['none', 'Ingen', false],
    ]);
    const note = 'Maskinporten støttes ikke ennå for MCP-servere, A2A-agenter og REST-verktøy.';
    expect(screen.getByText(note)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Arkiv' } });
    fireEvent.change(screen.getByLabelText('Adresse til MCP-serveren'), {
      target: { value: 'https://mcp.arkiv.testetaten.example.no' },
    });
    fireEvent.change(auth, { target: { value: 'api-key' } });
    const secret = (await screen.findByLabelText('Hemmelighet')) as HTMLSelectElement;
    await waitFor(() =>
      expect([...secret.options].map((o) => o.textContent)).toEqual([
        'Velg hemmelighet',
        'arkiv-nokkel',
        'saks-api',
      ]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    expect(screen.getByText('Velg en hemmelighet.')).toBeTruthy();

    fireEvent.change(secret, { target: { value: 'secret://tenant/999888777/saks-api' } });
    fireEvent.change(screen.getByLabelText('Navn på header (valgfritt)'), {
      target: { value: 'x-arkiv-key' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Manifest', { selector: 'pre' }).textContent).toContain(
        'secret: secret://tenant/999888777/saks-api',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    expect(await screen.findByText('Kontrakttest bestått')).toBeTruthy();
    expectAccessible();

    fireEvent.click(screen.getByRole('radio', { name: /A2A-agent/ }));
    expect((screen.getByLabelText('Innlogging') as HTMLSelectElement).value).toBe('api-key');
    expect(screen.getByLabelText('Adressen til agenten')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Utvidelsespunkt/ }));
    expect(screen.queryByText(note)).toBeNull();
  });

  it('the mock refuses Maskinporten and secrets of other tenants for MCP like the API', async () => {
    const fetch = blocksFetch();
    const test = async (auth: Record<string, string>) => {
      const res = await fetch('/api/tenants/999888777/building-blocks/contract-tests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'mcp',
          name: 'Arkiv',
          endpoint: 'https://mcp.arkiv.testetaten.example.no',
          auth,
        }),
      });
      return (await res.json()) as { passed: boolean; results: unknown[] };
    };

    expect(await test({ kind: 'maskinporten' })).toMatchObject({
      passed: false,
      results: [
        {
          name: 'Oppsettet er gyldig',
          passed: false,
          reason: 'Innlogging med Maskinporten støttes ikke ennå for MCP-servere.',
        },
      ],
    });
    expect(await test({ kind: 'api-key', secret: 'secret://env/FOUNDRY_KEY' })).toMatchObject({
      passed: false,
      results: [{ reason: 'Velg en av hemmelighetene til virksomheten.' }],
    });
    expect(await test({ kind: 'none' })).toMatchObject({ passed: true });
  });

  it('imports an OpenAPI file with read operations picked and writes off until turned on', async () => {
    await open('#/building-blocks/new', { secrets: ['saks-api'] });
    await screen.findByRole('heading', { level: 1, name: 'Legg til egen byggekloss' });
    fireEvent.click(screen.getByRole('radio', { name: /REST-verktøy fra OpenAPI-fil/ }));
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Saks-API' } });
    fireEvent.change(screen.getByLabelText('Adresse til API-et'), {
      target: { value: 'https://api.testetaten.example.no/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    expect(screen.getByText('Velg en OpenAPI-fil eller skriv adressen til den.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Eller adresse til OpenAPI-fila'), {
      target: { value: 'https://api.testetaten.example.no/openapi.json' },
    });
    expect(screen.queryByLabelText('OpenAPI-fil (JSON eller YAML)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    expect(await screen.findByText('Kontrakttest bestått')).toBeTruthy();

    const read = screen.getByRole('checkbox', { name: /GET \/saker\/\{id\}/ }) as HTMLInputElement;
    const write = screen.getByRole('checkbox', { name: /POST \/saker/ }) as HTMLInputElement;
    expect(read.checked).toBe(true);
    expect(write.checked).toBe(false);
    expect(write.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Endrer data\. Slå på skriving først\./)).toBeTruthy();
    expectAccessible();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Tillat operasjoner som endrer data' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /POST \/saker/ }));
    expect(screen.queryByText('Kontrakttest bestått')).toBeNull();
    expect(
      (screen.getByRole('checkbox', { name: /POST \/saker/ }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    await screen.findByText('Kontrakttest bestått');
    fireEvent.change(screen.getByLabelText('Begrunnelse', { exact: false }), {
      target: { value: 'REST-verktøy for saker' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registrer byggeklossen' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Saks-API' })).toBeTruthy();
    expect(
      screen.getByText(/operasjonene som endrer data er sendt til Digdir for godkjenning/),
    ).toBeTruthy();
    expect(screen.getByText(/saks-api\.hentsak/)).toBeTruthy();
    expect(screen.queryByText(/saks-api\.opprettsak/)).toBeNull();
  });

  it('registers an A2A agent from its agent card', async () => {
    await open('#/building-blocks/new');
    await screen.findByRole('heading', { level: 1, name: 'Legg til egen byggekloss' });
    fireEvent.click(screen.getByRole('radio', { name: /A2A-agent/ }));
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Skatteveilederen' } });
    fireEvent.change(screen.getByLabelText('Adressen til agenten'), {
      target: { value: 'https://agent.skatt.example.no' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Manifest', { selector: 'pre' }).textContent).toContain(
        'endpoint: https://agent.skatt.example.no/.well-known/agent-card.json',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hent agentkortet' }));
    expect(await screen.findByText('Kontrakttest bestått')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Skatteveilederen' })).toBeTruthy();
    expect(screen.getByText('Versjon 0.3')).toBeTruthy();
    expect(
      screen.getByText(/Skatt på tilskudd: svarer på om et tilskudd er skattepliktig/),
    ).toBeTruthy();
    expect(screen.getByText('Har et gyldig agentkort (A2A 1.0)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse', { exact: false }), {
      target: { value: 'Ny agent for skatt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registrer byggeklossen' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Skatteveilederen' })).toBeTruthy();
  });

  it('asks for the token address and client id with an OAuth client', async () => {
    await open('#/building-blocks/new', { secrets: ['saks-api'] });
    await screen.findByRole('heading', { level: 1, name: 'Legg til egen byggekloss' });
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Arkiv' } });
    fireEvent.change(screen.getByLabelText('Adresse til MCP-serveren'), {
      target: { value: 'https://mcp.arkiv.testetaten.example.no' },
    });
    fireEvent.change(screen.getByLabelText('Innlogging'), {
      target: { value: 'oauth-client-credentials' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));

    expect(screen.getByText('Skriv klient-ID-en.')).toBeTruthy();
    expect(screen.getByText('Velg en hemmelighet.')).toBeTruthy();
    expect(screen.queryByLabelText('Navn på header (valgfritt)')).toBeNull();
    expectAccessible();
  });

  it('users without the register right cannot open the form', async () => {
    await openAsViewer('#/building-blocks/new');
    expect(
      await screen.findByText(/trenger du rettigheten «Registrere byggeklosser»/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Registrer byggeklossen' })).toBeNull();
    expectAccessible();
  });
});

describe('Byggeklosser: API-format', () => {
  const llama: CatalogItem = {
    id: 'local/llama-3',
    kind: 'model',
    name: 'Llama 3 (lokal)',
    description: 'llama',
    publisher: { type: 'digdir', name: 'Digdir' },
    version: '1',
    dataLocation: 'norway',
    status: 'available',
    capabilities: ['chat', 'tools'],
    permissions: [{ type: 'model', value: 'local/llama-3', note: 'norway' }],
    usedBy: [],
    scores: [],
    settingsSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          title: 'Kan brukes i tjenestene',
          description: 'Slå av for å stoppe bruken uten å fjerne byggeklossen.',
          default: true,
        },
      },
      additionalProperties: false,
    },
    tenantOverrides: {},
    settingsVersion: 0,
    right: 'manage-services',
  };
  const rules: CatalogItem = {
    ...llama,
    id: 'custom-rules/fnr',
    kind: 'guardrail',
    name: 'fnr',
    description: 'Fødselsnummer stoppes.',
    dataLocation: null,
    status: 'in_use',
    capabilities: ['regex'],
    permissions: [],
    usedBy: [{ id: 'klarsprak', name: 'Klarspråk', version: 2 }],
  };

  it('settings are read-only until the block is in use', async () => {
    await open('#/building-blocks/model/local%2Fllama-3', { items: [llama], versions: {} });
    await screen.findByRole('heading', { level: 1, name: 'Llama 3 (lokal)' });
    const note = 'Ta byggeklossen i bruk for å endre innstillingene for Testetaten.';
    expect(screen.getByText(note)).toBeTruthy();
    expect(
      (screen.getByRole('switch', { name: 'Kan brukes i tjenestene' }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk hos oss' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Lokal modell for interne notater' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk' }));
    await screen.findByText(/Llama 3 \(lokal\) er tatt i bruk hos Testetaten/);
    await waitFor(() => expect(screen.queryByText(note)).toBeNull());
    expect(
      (screen.getByRole('switch', { name: 'Kan brukes i tjenestene' }) as HTMLInputElement)
        .disabled,
    ).toBe(false);
  });

  it('runs list, detail and adopt with ids that contain a slash', async () => {
    const calls: string[] = [];
    const fetch = blocksFetch({ items: [llama, rules], versions: {} });
    const recording: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? 'GET'} ${new URL(url, 'http://mock').pathname}`);
      return fetch(input, init);
    };
    await renderAt('#/building-blocks', recording);
    expect(await screen.findByRole('tab', { name: 'I bruk hos oss (1)' })).toBeTruthy();
    const guard = screen.getByRole('link', { name: 'fnr' }).closest('li') as HTMLElement;
    expect(within(guard).getByText('Digdir · versjon 1 · Brukes av 1 tjeneste')).toBeTruthy();
    expect(within(guard).queryByText(/^Data /)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Katalog (2)' }));
    const link = await screen.findByRole('link', { name: 'Llama 3 (lokal)' });
    expect(link.getAttribute('href')).toBe('#/building-blocks/model/local%2Fllama-3');
    expect(within(link.closest('li') as HTMLElement).getByText('Data i Norge')).toBeTruthy();

    window.location.hash = link.getAttribute('href') ?? '';
    await screen.findByRole('heading', { level: 1, name: 'Llama 3 (lokal)' });
    expect(calls).toContain('GET /api/tenants/999888777/building-blocks/model/local%2Fllama-3');
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk hos oss' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Lokal modell for interne notater' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk' }));
    expect(await screen.findByText(/Llama 3 \(lokal\) er tatt i bruk hos Testetaten/)).toBeTruthy();
    expect(screen.getByText(/«Lokal modell for interne notater»\. Logget\./)).toBeTruthy();
    expect(calls).toContain(
      'POST /api/tenants/999888777/building-blocks/model/local%2Fllama-3/adopt',
    );
    expect(await screen.findByText('Tatt i bruk')).toBeTruthy();
    expect(screen.getByText('I bruk')).toBeTruthy();
  });
});

describe('Byggeklosser: Langfuse-dommere', () => {
  const rule = 'svar_oppfyller_kriteriene-eksperimenter';
  const judgeBlock = (over: Partial<CatalogItem> = {}): CatalogItem => ({
    id: `langfuse:kudos/${rule}`,
    kind: 'judge',
    name: rule,
    description: '',
    publisher: { type: 'own', name: 'Testetaten' },
    version: '1',
    dataLocation: 'global',
    status: 'available',
    capabilities: [],
    permissions: [],
    usedBy: [],
    scores: [],
    settingsSchema: { type: 'object', properties: {} },
    tenantOverrides: {},
    settingsVersion: 0,
    right: 'manage-services',
    judge: {
      connection: 'kudos',
      model: 'foundry-claude/claude-sonnet-5',
      version: '1',
      dataType: 'BOOLEAN',
      fields: [
        { variable: 'input', source: 'input' },
        { variable: 'output', source: 'output' },
        { variable: 'criteria', source: 'expected_output', jsonPath: '$.criteria' },
      ],
    },
    ...over,
  });
  const detailOf = (block: CatalogItem) =>
    `#/building-blocks/judge/${encodeURIComponent(block.id)}`;

  it("shows each active experiment rule of a connection's project as a judge block with its model, evaluator version, data type and mapped fields, and adds it only with Ta i bruk and a reason", async () => {
    const short = judgeBlock({
      id: 'langfuse:kudos/svar_er_kort-eksperimenter',
      name: 'svar_er_kort-eksperimenter',
    });
    const items = [judgeBlock(), short];

    await open('#/building-blocks', { items });
    fireEvent.click(await screen.findByRole('tab', { name: /Katalog/ }));
    expect(await screen.findByRole('link', { name: rule })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'svar_er_kort-eksperimenter' })).toBeTruthy();
    cleanup();

    await open(detailOf(judgeBlock()), { items });
    await screen.findByRole('heading', { level: 1, name: rule });
    expect(
      screen.getByText(
        'Langfuse-dommer i koblingen kudos. Den er rådgivende og stopper aldri en publisering.',
      ),
    ).toBeTruthy();
    const fact = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    expect(fact('Modell')).toBe('foundry-claude/claude-sonnet-5');
    expect(fact('Dommerversjon')).toBe('1');
    expect(fact('Svartype')).toBe('Ja eller nei');
    expect(fact('Leser')).toBe(
      'input ← input, output ← output, criteria ← expected_output $.criteria',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk hos oss' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk' }));
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Kudos-teamet bruker denne dommeren i Langfuse' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk' }));
    expect(
      await screen.findByText(new RegExp(`${rule} er tatt i bruk hos Testetaten`)),
    ).toBeTruthy();
    expectAccessible();
  });

  it("shows why a Langfuse judge block is refused: the project's default model, or a field genki does not send", async () => {
    const defaultModel = judgeBlock({
      status: 'not_allowed',
      policyBlock: {
        rule: 'refused',
        ownedBy: 'Testetaten',
        text: `${rule} uses the project's or organisation's default model, which cannot be read through Langfuse's API`,
      },
      judge: {
        ...(judgeBlock().judge as NonNullable<CatalogItem['judge']>),
        model: undefined,
        refused: {
          reason: 'default-model',
          message: `${rule} uses the project's or organisation's default model, which cannot be read through Langfuse's API`,
        },
      },
    });
    const toolCalls = judgeBlock({
      id: 'langfuse:kudos/verktøy-eksperimenter',
      name: 'verktøy-eksperimenter',
      status: 'not_allowed',
      policyBlock: {
        rule: 'refused',
        ownedBy: 'Testetaten',
        text: 'verktøy-eksperimenter reads tool_calls, which genki does not send',
      },
      judge: {
        ...(judgeBlock().judge as NonNullable<CatalogItem['judge']>),
        refused: {
          reason: 'unsent-field',
          field: 'tool_calls',
          message: 'verktøy-eksperimenter reads tool_calls, which genki does not send',
        },
      },
    });

    await open(detailOf(defaultModel), { items: [defaultModel, toolCalls] });
    await screen.findByRole('heading', { level: 1, name: rule });
    const refusal = screen
      .getByText(
        'Dommeren bruker prosjektets standardmodell, som ikke kan leses gjennom Langfuse. Velg en modell for dommeren i Langfuse for å ta den i bruk.',
      )
      .closest('.ds-alert');
    expect(refusal?.getAttribute('data-color')).toBe('danger');
    expect(screen.getByText('Modell').nextElementSibling?.textContent).toBe(
      'Prosjektets standardmodell',
    );
    expect(screen.queryByText(/default model/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ta i bruk hos oss' })).toBeNull();
    cleanup();

    await open(detailOf(toolCalls), { items: [defaultModel, toolCalls] });
    await screen.findByRole('heading', { level: 1, name: 'verktøy-eksperimenter' });
    expect(screen.getByText('Dommeren leser tool_calls, som genki ikke sender.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ta i bruk hos oss' })).toBeNull();
    expectAccessible();
  });

  it('shows that a Langfuse judge on a connection without answer text cannot be taken in use', async () => {
    const message = `${rule} has nothing to judge: the connection kudos gets no answer text`;
    const silent = judgeBlock({
      status: 'not_allowed',
      policyBlock: { rule: 'refused', ownedBy: 'Testetaten', text: message },
      judge: {
        ...(judgeBlock().judge as NonNullable<CatalogItem['judge']>),
        refused: { reason: 'no-content', connection: 'kudos', message },
      },
    });

    await open(detailOf(silent), { items: [silent] });
    await screen.findByRole('heading', { level: 1, name: rule });

    expect(
      screen.getByText(
        'Koblingen kudos får ikke svartekst, så dommeren har ingenting å vurdere. Slå på «Send tekst» for koblingen under Integrasjoner, Sporing og evaluering, for å ta den i bruk.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ta i bruk hos oss' })).toBeNull();
  });
});
