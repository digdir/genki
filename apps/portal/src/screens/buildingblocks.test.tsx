// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import type { ToolConnectionDetail } from '../api/blocks';
import type { CatalogItem, CatalogProposal } from '../api/building-blocks';
import { exampleBlocks, exampleProposal } from '../data/building-blocks';
import { exampleStepFlow, mockFetch } from '../mock';
import type { BuildingBlocksMockOptions } from '../mock/building-blocks';
import { translator } from '../i18n';
import { versionText } from './buildingblocks/common';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';

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
  within(screen.getByRole('main'))
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent)
    .filter((t) => t !== 'Kunne ikke hente dataene');

const settingFor = (label: string) =>
  screen.getByLabelText(label, { exact: false }).closest('.bb-setting') as HTMLElement;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => cleanup());

const nbT = translator('nb');

describe('Byggeklosser: liste', () => {
  it('shows the blocks in use grouped by type under the design header, with link tabs and a live count', async () => {
    await open('#/building-blocks');
    expect(await screen.findByRole('heading', { level: 1, name: 'Byggeklosser' })).toBeTruthy();
    expect(
      screen.getByText(
        'Delene tjenestene i Testetaten bygges av: modeller, søk, verktøy, ferdigheter, vern, dommere og stegflyter.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Registrer byggekloss' }).getAttribute('href')).toBe(
      '#/building-blocks/new',
    );
    const inUse = screen.getByRole('tab', { name: 'I bruk hos oss' });
    expect(inUse.getAttribute('aria-selected')).toBe('true');
    expect(inUse.getAttribute('href')).toBe('#/building-blocks/in-use');
    expect(screen.getByRole('tab', { name: 'Katalog' }).getAttribute('href')).toBe(
      '#/building-blocks/catalogue',
    );
    expect(screen.getByText('Viser 18 av 18 byggeklosser')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Modeller (1)' })).toBeTruthy();
    const borealis = screen
      .getByRole('link', { name: 'Borealis-27B' })
      .closest('li') as HTMLElement;
    expect(within(borealis).getByText('Data i Norge')).toBeTruthy();
    expect(within(borealis).getByText('Oppdatering tilgjengelig')).toBeTruthy();
    expect(within(borealis).getByText('Brukes i 5 tjenester')).toBeTruthy();
    expectAccessible();
  });

  it('has no publisher filter and no API-call button, which the design does not have', async () => {
    await open('#/building-blocks', { proposals: [] });
    await screen.findByRole('link', { name: 'Borealis-27B' });
    expect(screen.queryByLabelText('Utgiver')).toBeNull();
    expect(screen.queryByRole('button', { name: /API-kall/ })).toBeNull();
  });

  it('type chips are pressed buttons with counts that filter the groups', async () => {
    await open('#/building-blocks/catalogue', { proposals: [] });
    const all = await screen.findByRole('button', { name: 'Alle 9' });
    expect(all.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Modeller 3' }));
    expect(groupHeadings()).toEqual(['Modeller (3)']);
    expect(screen.getByText('Viser 3 av 9 i katalogen')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Søk i katalogen'), { target: { value: 'zzz' } });
    expect(
      screen.getByRole('heading', { name: 'Ingen byggeklosser i katalogen passer søket' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill søk og filter' }));
    expect(screen.getByRole('button', { name: 'Alle 9' })).toBeTruthy();
  });

  it('the catalogue lists only blocks not in use yet', async () => {
    await open('#/building-blocks/catalogue', { proposals: [] });
    expect(await screen.findByRole('link', { name: 'Qwen3.8-27B' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Borealis-27B' })).toBeNull();
  });

  it('Ta i bruk in the catalogue asks why, takes the block into use and links to it under I bruk hos oss', async () => {
    await open('#/building-blocks/catalogue', { proposals: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Ta i bruk Qwen3.8-27B' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Ta i bruk Qwen3.8-27B?' })).toBeTruthy();
    expect(
      within(dialog).getByText(
        'Alle tjenesteeiere i Testetaten kan velge Qwen3.8-27B når de bygger. Ingen tjeneste endres før noen velger den.',
      ),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Hvorfor tar dere den i bruk?'), {
      target: { value: 'Lokal modell for korte svar' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ta i bruk' }));
    expect(
      await screen.findByText(/Qwen3\.8-27B er tatt i bruk\. Tjenestene kan velge den nå\./),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se den under I bruk hos oss' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Qwen3.8-27B' })).toBeNull());
  });

  it('a block that needs approval is sent for approval from the catalogue and then waits', async () => {
    await open('#/building-blocks/catalogue', { proposals: [] });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Ta i bruk GPT-4.1 (Azure OpenAI)' }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Hvorfor tar dere den i bruk?'), {
      target: { value: 'Trengs for lange tabeller' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send til godkjenning' }));
    expect(await screen.findByText(/venter på godkjenning\. Vi sier fra på Oversikt/)).toBeTruthy();
    const row = (await screen.findByRole('link', { name: 'GPT-4.1 (Azure OpenAI)' })).closest(
      'li',
    ) as HTMLElement;
    expect(await within(row).findByText('Venter på godkjenning')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Ta i bruk/ })).toBeNull();
  });

  it('closing the adopt dialog with a typed reason asks before discarding it', async () => {
    await open('#/building-blocks/catalogue', { proposals: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Ta i bruk Qwen3.8-27B' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Hvorfor tar dere den i bruk?'), {
      target: { value: 'Noe jeg skrev' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt' }));
    expect(within(dialog).getByText('Forkaste det du har skrevet?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fortsett å skrive' }));
    expect(
      (within(dialog).getByLabelText('Hvorfor tar dere den i bruk?') as HTMLTextAreaElement).value,
    ).toBe('Noe jeg skrev');
  });

  it('shows the design empty state with a link to the catalogue when nothing is in use', async () => {
    await open('#/building-blocks', { empty: true });
    expect(
      await screen.findByRole('heading', { name: 'Ingen byggeklosser i bruk ennå' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se katalogen' }).getAttribute('href')).toBe(
      '#/building-blocks/catalogue',
    );
    expectAccessible();
  });

  it('lets a new organisation with nothing in use create or import a skill', async () => {
    await open('#/building-blocks/in-use?type=skill', { empty: true });
    await screen.findByRole('heading', { name: 'Ingen byggeklosser i bruk ennå' });
    expect(await screen.findByRole('button', { name: 'Ny ferdighet' })).toBeTruthy();
    expect(screen.getByText('Importer pakke')).toBeTruthy();
  });

  it('shows only three step flows until asked for all of them', async () => {
    const flow = exampleBlocks.find((b) => b.id === 'postruting') as CatalogItem;
    const flows = Array.from({ length: 5 }, (_, i) => ({
      ...flow,
      id: `flyt-${i}`,
      name: `Flyt ${i}`,
    }));
    await open('#/building-blocks', { items: flows, proposals: [] });
    await screen.findByRole('heading', { level: 2, name: 'Stegflyter (5)' });
    expect(screen.queryByRole('link', { name: 'Flyt 3' })).toBeNull();
    const more = screen.getByRole('button', { name: 'Vis alle 5 stegflyter' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getByRole('link', { name: 'Flyt 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Vis færre stegflyter' })).toBeTruthy();
  });

  it('shows the design error text with retry when the list cannot be loaded', async () => {
    await renderAt(
      '#/building-blocks/catalogue',
      failingFetch(/\/building-blocks(\?|$)/, 503, blocksFetch()),
    );
    expect(
      await screen.findByRole('heading', { name: 'Vi fikk ikke hentet katalogen' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });

  it('read-only users see no change buttons and the rights alert', async () => {
    await openAsViewer('#/building-blocks');
    await screen.findByRole('heading', { level: 1, name: 'Byggeklosser' });
    expect(screen.getByText(/Du kan se byggeklossene, men ikke endre dem/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Registrer byggekloss' })).toBeNull();
    expectAccessible();
    cleanup();
    await openAsViewer('#/building-blocks/catalogue');
    await screen.findByRole('link', { name: 'Qwen3.8-27B' });
    expect(screen.queryByRole('button', { name: /^Ta i bruk/ })).toBeNull();
    cleanup();
    await openAsViewer('#/building-blocks/model/qwen');
    await screen.findByRole('heading', { level: 1, name: 'Qwen3.8-27B' });
    expect(screen.getByText(/Du kan se byggeklossen, men ikke endre den/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ta i bruk hos oss' })).toBeNull();
    expect((screen.getByLabelText('Tidsavbrudd (sekunder)') as HTMLInputElement).disabled).toBe(
      true,
    );
    expectAccessible();
  });
});

describe('Byggeklosser: adressen', () => {
  it('opens the catalogue tab from its own address', async () => {
    await open('#/building-blocks/catalogue', { proposals: [] });
    const tab = await screen.findByRole('tab', { name: 'Katalog' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Viser 9 av 9 i katalogen')).toBeTruthy();
  });

  it('arrow keys move between the tabs and change the address', async () => {
    await open('#/building-blocks', { proposals: [] });
    await screen.findByRole('link', { name: 'Borealis-27B' });
    const inUse = screen.getByRole('tab', { name: 'I bruk hos oss' });
    fireEvent.keyDown(inUse, { key: 'ArrowRight' });
    await waitFor(() => expect(window.location.hash).toBe('#/building-blocks/catalogue'));
    expect(document.activeElement?.textContent).toBe('Katalog');
  });

  it('keeps the type filter and the search in the address', async () => {
    await open('#/building-blocks/catalogue', { proposals: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Modeller 3' }));
    fireEvent.change(screen.getByLabelText('Søk i katalogen'), { target: { value: 'qwen' } });
    await waitFor(() =>
      expect(window.location.hash).toBe('#/building-blocks/catalogue?type=model&q=qwen'),
    );
    cleanup();

    await open('#/building-blocks/catalogue?type=model&q=qwen', { proposals: [] });
    expect(
      (await screen.findByRole('button', { name: 'Modeller 1' })).getAttribute('aria-pressed'),
    ).toBe('true');
    expect((screen.getByLabelText('Søk i katalogen') as HTMLInputElement).value).toBe('qwen');
    expect(groupHeadings()).toEqual(['Modeller (1)']);
  });

  it('shows a failed proposals load with retry instead of hiding it', async () => {
    let fail = true;
    const ok = blocksFetch();
    const broken = failingFetch(/\/proposals\?/, 503, ok);
    await renderAt('#/building-blocks', (input, init) =>
      fail ? broken(input, init) : ok(input, init),
    );
    expect(await screen.findByRole('heading', { name: 'Kunne ikke hente dataene' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Borealis-27B' })).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Kunne ikke hente dataene' })).toBeNull(),
    );
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
    expect(screen.queryByRole('navigation', { name: 'Brødsmuler' })).toBeNull();
    expect(
      within(screen.getByRole('main'))
        .getByRole('link', { name: 'Byggeklosser' })
        .getAttribute('href'),
    ).toBe('#/building-blocks');
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
    await open('#/building-blocks/model/aivar%2Fborealis-27b');
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

  it('shows the update table and test scores on the Om tab of a block with an update', async () => {
    await open('#/building-blocks/model/aivar%2Fborealis-27b');
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    expect(
      screen.getByRole('heading', { name: 'Versjon 2.2, tilgjengelig fra 6. okt' }),
    ).toBeTruthy();
    const table = screen.getByRole('region', { name: 'Poeng før og etter per tjeneste' });
    expect(within(table).getByText('+3')).toBeTruthy();
    expect(within(table).getByText('−1')).toBeTruthy();
    expect(within(table).getByText('Ingen endring')).toBeTruthy();
    expect(
      within(table).getByRole('link', { name: 'Rapportassistenten' }).getAttribute('href'),
    ).toBe('#/services/rapportassistenten');
    expect(screen.getByText('84 av 100')).toBeTruthy();
    expectAccessible();
  });

  it('keeps the versions of a block on its own Versjoner tab with its own address', async () => {
    await open('#/building-blocks/model/aivar%2Fborealis-27b');
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    expect(screen.queryByText('Versjon 2.0')).toBeNull();
    const tab = screen.getByRole('tab', { name: 'Versjoner' });
    expect(tab.getAttribute('href')).toBe('#/building-blocks/model/aivar%2Fborealis-27b/versions');
    expect(screen.getByRole('tab', { name: 'Om' }).getAttribute('aria-selected')).toBe('true');
    window.location.hash = '#/building-blocks/model/aivar%2Fborealis-27b/versions';
    expect(await screen.findByText('Versjon 2.0')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Versjoner' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expectAccessible();
  });

  it('lists the services that use a block on the Brukes av tab with their runs in the last 7 days', async () => {
    await open('#/building-blocks/model/aivar%2Fborealis-27b/used-by');
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Brukes i 5 tjenester' }),
    ).toBeTruthy();
    const table = screen.getByRole('region', { name: 'Tjenester som bruker Borealis-27B' });
    expect(
      within(table).getByRole('columnheader', { name: 'Kjøringer siste 7 dager' }),
    ).toBeTruthy();
    const row = within(table).getByRole('link', { name: 'Rapportassistenten' }).closest('tr');
    expect(row?.querySelector('td')?.textContent).toMatch(/^[\d\s]+$|^–$/);
    expectAccessible();
  });

  it('describes what a model is good at in plain language, not raw capability names', async () => {
    const terra: CatalogItem = {
      ...(exampleBlocks.find((b) => b.id === 'aivar/borealis-27b') as CatalogItem),
      id: 'gpt-5.6-terra',
      name: 'gpt-5.6-terra',
      dataLocation: 'eu',
      capabilities: ['stream', 'tools', 'json-schema', 'reasoning'],
      permissions: [{ type: 'model', value: 'gpt-5.6-terra', note: 'eu' }],
    };
    await open('#/building-blocks/model/gpt-5.6-terra', { items: [...exampleBlocks, terra] });
    await screen.findByRole('heading', { level: 1, name: 'gpt-5.6-terra' });
    const good = screen.getByRole('heading', { name: 'Hva den er god til' }).closest('section');
    expect(within(good as HTMLElement).getByText('Viser svaret mens det skrives.')).toBeTruthy();
    expect(
      within(good as HTMLElement).getByText(
        'Kan svare i faste felter, for eksempel til et skjema.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('json-schema')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Tilganger' })).toBeNull();
    expect(screen.queryByText('eu')).toBeNull();
  });

  it('says in prose where a block processes data, with a link to how data is handled', async () => {
    await open('#/building-blocks/model/aivar%2Fborealis-27b');
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    const where = screen.getByRole('heading', { name: 'Hvor data behandles' }).closest('section');
    expect(where?.textContent).toContain('I Norge. Det Borealis-27B får, behandles i Norge.');
    expect(
      within(where as HTMLElement)
        .getByRole('link', { name: 'Slik behandles data' })
        .getAttribute('href'),
    ).toBe('#/data-handling');
  });

  it('says in the lead how many services use the block and who it is from', async () => {
    await open('#/building-blocks/model/aivar%2Fborealis-27b');
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    expect(screen.getByText('Modell · fra Digdir')).toBeTruthy();
    expect(screen.getByText(/Brukes i 5 tjenester\.$/)).toBeTruthy();
  });

  it('lists each tool of a connected tool by name with its description, and shows its address', async () => {
    const archive: CatalogItem = {
      ...(exampleBlocks.find((b) => b.kind === 'tool') as CatalogItem),
      id: 'arkivsystemet',
      name: 'Arkivsystemet',
      description: 'https://arkiv.testetaten.no/mcp',
      publisher: { type: 'own', name: '999888777' },
      dataLocation: null,
      capabilities: ['sok: Søker etter saker og dokumenter.', 'hent'],
    };
    await open('#/building-blocks/tool/arkivsystemet', { items: [...exampleBlocks, archive] });
    await screen.findByRole('heading', { level: 1, name: 'Arkivsystemet' });
    expect(screen.getByText('Verktøy · fra Testetaten')).toBeTruthy();
    const tools = screen.getByRole('heading', { name: 'Verktøyene den tilbyr' }).closest('section');
    expect(within(tools as HTMLElement).getByText('sok')).toBeTruthy();
    expect(within(tools as HTMLElement).getByText('Søker etter saker og dokumenter.')).toBeTruthy();
    expect(within(tools as HTMLElement).getByText('hent')).toBeTruthy();
    const address = screen.getByText('Adresse', { selector: 'dt' }).nextElementSibling;
    expect(address?.textContent).toBe('https://arkiv.testetaten.no/mcp');
  });

  it('hides the access table of a block that gets access to nothing', async () => {
    const empty: CatalogItem = {
      ...(exampleBlocks.find((b) => b.id === 'sf-hoering') as CatalogItem),
      permissions: [],
    };
    await open('#/building-blocks/step_flow/sf-hoering', {
      items: [...exampleBlocks.filter((b) => b.id !== 'sf-hoering'), empty],
    });
    await screen.findByRole('heading', { level: 1, name: 'Høringsoppsummering' });
    expect(screen.queryByRole('heading', { name: 'Hva den får tilgang til' })).toBeNull();
  });
  it('the settings form shows inherited, overridden and changed tags', async () => {
    await open('#/building-blocks/model/aivar%2Fborealis-27b');
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
    await open('#/building-blocks/model/aivar%2Fborealis-27b');
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

describe('Byggeklosser: versjoner og overlevering', () => {
  it('shows an empty text when a block has no versions', async () => {
    await open('#/building-blocks/model/qwen/versions', { versions: {} });
    await screen.findByRole('heading', { level: 1, name: 'Qwen3.8-27B' });
    expect(
      await screen.findByText('Ingen versjoner eller endringer er registrert ennå.'),
    ).toBeTruthy();
  });

  it('shows the versions error with retry', async () => {
    let fail = true;
    const ok = blocksFetch();
    const broken = failingFetch(/\/versions$/, 503, ok);
    await renderAt('#/building-blocks/model/aivar%2Fborealis-27b/versions', (input, init) =>
      fail ? broken(input, init) : ok(input, init),
    );
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    expect(
      screen.getByRole('heading', { level: 3, name: 'Kunne ikke hente dataene' }),
    ).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByText('Versjon 2.0')).toBeTruthy();
  });

  it('keeps the typed reason when the block reloads', async () => {
    let fail = true;
    const ok = blocksFetch();
    const broken = failingFetch(/\/versions$/, 503, ok);
    await renderAt('#/building-blocks/model/qwen/versions', (input, init) =>
      fail ? broken(input, init) : ok(input, init),
    );
    await screen.findByRole('heading', { level: 1, name: 'Qwen3.8-27B' });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk hos oss' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Raskere uttrekk i Postsortering' },
    });
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Kunne ikke hente dataene' })).toBeNull(),
    );
    expect((screen.getByLabelText('Begrunnelse') as HTMLTextAreaElement).value).toBe(
      'Raskere uttrekk i Postsortering',
    );
  });

  it('links a block to services without a hand-off the builder does not read', async () => {
    await open('#/building-blocks/model/aivar%2Fborealis-27b');
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    expect(screen.queryByRole('button', { name: 'Legg til i en tjeneste' })).toBeNull();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.filter((h) => h.includes('byggekloss='))).toEqual([]);
  });
});

describe('Byggeklosser: legg til egen', () => {
  it('Registrer byggeklossen stays disabled until the contract test passes and clears on edit', async () => {
    await open('#/building-blocks/new');
    await screen.findByRole('heading', { level: 1, name: 'Registrer byggekloss' });
    const register = () => screen.getByRole('button', { name: 'Registrer byggeklossen' });
    expect(register().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    expect(screen.getByText('Skriv et navn.')).toBeTruthy();
    expect(screen.getByText('Skriv en adresse som begynner med https://')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Saksarkivet (MCP)' } });
    fireEvent.change(screen.getByLabelText('Adresse til MCP-serveren'), {
      target: { value: 'https://mcp.saksarkiv.testetaten.example.no' },
    });
    expect(await screen.findByText('mcp.saksarkiv.testetaten.example.no')).toBeTruthy();
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
    await screen.findByRole('heading', { level: 1, name: 'Registrer byggekloss' });
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
    await screen.findByRole('heading', { level: 1, name: 'Registrer byggekloss' });
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

  it('offers only the three types the API can register, with no internal tags', async () => {
    await open('#/building-blocks/new');
    await screen.findByRole('heading', { level: 1, name: 'Registrer byggekloss' });
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([
      expect.stringContaining('MCP'),
      expect.stringContaining('OpenAPI'),
      expect.stringContaining('A2A'),
    ]);
    expect(screen.queryByText('API ikke bestemt')).toBeNull();
    expect(screen.queryByRole('radio', { name: /Utvidelsespunkt/ })).toBeNull();
    expectAccessible();
  });

  it('asks where the data is processed without an extra list request, and sends it with the registration', async () => {
    const calls: { path: string; body: string }[] = [];
    const fetch = blocksFetch();
    await renderAt('#/building-blocks/new', (input, init) => {
      const url = String(input);
      if (/\/building-blocks(\?|$)/.test(url)) calls.push({ path: url, body: '' });
      if (init?.body && url.includes('manifest-preview'))
        calls.push({ path: url, body: String(init.body) });
      return fetch(input, init);
    });
    await screen.findByRole('heading', { level: 1, name: 'Registrer byggekloss' });
    const where = (await screen.findByLabelText('Hvor behandles dataene?')) as HTMLSelectElement;
    expect(where.value).toBe('norway');
    fireEvent.change(where, { target: { value: 'eu' } });
    await waitFor(() => expect(calls.at(-1)?.body).toContain('"residency":"eu"'));
    expect(calls.filter((c) => !c.body)).toEqual([]);
  });

  it('shows how the block will look in Byggeklosser, built from the form', async () => {
    await open('#/building-blocks/new');
    await screen.findByRole('heading', { level: 1, name: 'Registrer byggekloss' });
    fireEvent.change(screen.getByLabelText('Navn'), {
      target: { value: 'Saksbehandlingssystemet' },
    });
    const card = within(
      screen
        .getByRole('heading', { name: 'Slik blir den seende ut' })
        .closest('section') as HTMLElement,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Slik blir den seende ut' })).toBeTruthy();
    expect(card.getByText('Saksbehandlingssystemet')).toBeTruthy();
    expect(card.getByText('Data i Norge')).toBeTruthy();
    expect(card.getByText('Verktøy · koblet til av Testetaten med MCP')).toBeTruthy();
    expect(screen.queryByLabelText('Manifest')).toBeNull();
  });

  it('MCP defaults to Ingen, marks Maskinporten unavailable and picks a stored secret', async () => {
    await open('#/building-blocks/new', { secrets: ['saks-api', 'arkiv-nokkel'] });
    await screen.findByRole('heading', { level: 1, name: 'Registrer byggekloss' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Kjør kontrakttest' }));
    expect(await screen.findByText('Kontrakttest bestått')).toBeTruthy();
    expectAccessible();

    fireEvent.click(screen.getByRole('radio', { name: /A2A-agent/ }));
    expect((screen.getByLabelText('Innlogging') as HTMLSelectElement).value).toBe('api-key');
    expect(screen.getByLabelText('Adressen til agenten')).toBeTruthy();
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
    await screen.findByRole('heading', { level: 1, name: 'Registrer byggekloss' });
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
    await screen.findByRole('heading', { level: 1, name: 'Registrer byggekloss' });
    fireEvent.click(screen.getByRole('radio', { name: /A2A-agent/ }));
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Skatteveilederen' } });
    fireEvent.change(screen.getByLabelText('Adressen til agenten'), {
      target: { value: 'https://agent.skatt.example.no' },
    });
    expect(
      within(
        screen
          .getByRole('heading', { name: 'Slik blir den seende ut' })
          .closest('section') as HTMLElement,
      ).getByText('Verktøy · koblet til av Testetaten med A2A'),
    ).toBeTruthy();
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
    await screen.findByRole('heading', { level: 1, name: 'Registrer byggekloss' });
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
    const guard = (await screen.findByRole('link', { name: 'fnr' })).closest('li') as HTMLElement;
    expect(within(guard).getByText('Brukes i 1 tjeneste')).toBeTruthy();
    expect(within(guard).queryByText(/^Data /)).toBeNull();
    window.location.hash = '#/building-blocks/catalogue';
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
    expect(await screen.findByText('Sist endret hos dere')).toBeTruthy();
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

  it("names the paths genki reads when a judge's path is refused", async () => {
    const message = `${rule} reads output at $..text, a JSON path genki cannot read; genki reads $, .key and [n]`;
    const pathed = judgeBlock({
      status: 'not_allowed',
      policyBlock: { rule: 'refused', ownedBy: 'Testetaten', text: message },
      judge: {
        ...(judgeBlock().judge as NonNullable<CatalogItem['judge']>),
        refused: { reason: 'unread-path', field: 'output $..text', message },
      },
    });

    await open(detailOf(pathed), { items: [pathed] });
    await screen.findByRole('heading', { level: 1, name: rule });
    expect(
      screen.getByText(
        'Dommeren leser output $..text, en JSON-sti genki ikke kan lese. genki leser $, .nøkkel og [n], for eksempel $[0].body.text.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ta i bruk hos oss' })).toBeNull();
  });

  it('says in Byggeklosser which filter genki cannot read', async () => {
    const message = `${rule} has a filter on level that genki cannot read`;
    const filtered = judgeBlock({
      status: 'not_allowed',
      policyBlock: { rule: 'refused', ownedBy: 'Testetaten', text: message },
      judge: {
        ...(judgeBlock().judge as NonNullable<CatalogItem['judge']>),
        refused: { reason: 'filtered', field: 'level', message },
      },
    });

    await open(detailOf(filtered), { items: [filtered] });
    await screen.findByRole('heading', { level: 1, name: rule });

    expect(
      screen.getByText(
        'Dommeren har et filter på level, som genki ikke kan lese før kjøringen. Fjern det filteret i Langfuse, eller hold testkjøringene utenfor med et annet filter.',
      ),
    ).toBeTruthy();
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
        'Koblingen kudos får ikke svartekst, så dommeren har ingenting å vurdere. Slå på «Send tekst» for koblingen under Utviklerverktøy, Sporing og evaluering, for å ta den i bruk.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ta i bruk hos oss' })).toBeNull();
  });
  it('shows that a Langfuse judge whose rule shares its name with another cannot be taken in use', async () => {
    const message = `${rule} is the name of more than one rule in the project, so genki cannot tell them apart`;
    const twin = judgeBlock({
      status: 'not_allowed',
      policyBlock: { rule: 'refused', ownedBy: 'Testetaten', text: message },
      judge: {
        ...(judgeBlock().judge as NonNullable<CatalogItem['judge']>),
        refused: { reason: 'same-name', message },
      },
    });

    await open(detailOf(twin), { items: [twin] });
    await screen.findByRole('heading', { level: 1, name: rule });

    expect(
      screen.getByText(
        'Flere regler i prosjektet har dette navnet, så genki kan ikke skille dem fra hverandre. Gi reglene ulike navn i Langfuse for å ta dem i bruk.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ta i bruk hos oss' })).toBeNull();
  });

  it('shows a connection whose Langfuse judges cannot be read as a refused block saying why', async () => {
    const message =
      'the judges of the connection kudos could not be read: Langfuse answered HTTP 404 for /api/public/v2/evaluation-rules';
    const unreadable = judgeBlock({
      id: 'sink-judges:kudos',
      name: 'Dommerne i Langfuse (kudos)',
      version: '',
      // As the API gives it: where runs go, and no field or model.
      permissions: [
        {
          type: 'network',
          value: 'https://langfuse.etaten.example.no',
          note: 'Hit sendes testkjøringene',
        },
      ],
      status: 'not_allowed',
      policyBlock: { rule: 'refused', ownedBy: 'Testetaten', text: message },
      judge: {
        connection: 'kudos',
        version: '',
        dataType: '',
        fields: [],
        refused: { reason: 'unreadable', connection: 'kudos', message },
      },
    });

    await open(detailOf(unreadable), { items: [unreadable] });
    await screen.findByRole('heading', { level: 1, name: 'Dommerne i Langfuse (kudos)' });

    const refusal = screen
      .getByText(
        'Dommerne i prosjektet til koblingen kudos kunne ikke leses (HTTP 404). Langfuse må ha versjon 4.23.0 eller nyere, og koblingens nøkler må gjelde.',
      )
      .closest('.ds-alert');
    expect(refusal?.getAttribute('data-color')).toBe('danger');
    // It is no judge: nothing to say about a model, version or fields.
    expect(screen.queryByText('Modell')).toBeNull();
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ta i bruk hos oss' })).toBeNull();
    expectAccessible();
  });
});

describe('skills in Byggeklosser', () => {
  it('opens a Digdir skill from the catalogue with its owner in the link', async () => {
    await open('#/building-blocks/catalogue');
    const link = await screen.findByRole('link', { name: 'Klarspråk i brev' });
    await waitFor(() =>
      expect(link.getAttribute('href')).toBe(
        '#/building-blocks/skill/klarsprak-i-brev?owner=991825827',
      ),
    );
    window.location.hash = link.getAttribute('href') ?? '';
    expect(await screen.findByRole('heading', { level: 1, name: 'Klarspråk i brev' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens a Digdir skill from a link without its owner', async () => {
    await open('#/building-blocks/skill/klarsprak-i-brev');
    expect(await screen.findByRole('heading', { level: 1, name: 'Klarspråk i brev' })).toBeTruthy();
  });

  it('lists a Digdir skill not yet taken into use only in the catalogue, not also among skills in use', async () => {
    await open('#/building-blocks/in-use?type=skill');
    await screen.findByRole('heading', { level: 2, name: /^Utkast og andre ferdigheter/ });
    expect(screen.queryByRole('link', { name: 'Klarspråk i brev' })).toBeNull();
  });

  it('lists drafts and skills shared by others under Ferdigheter, and both open', async () => {
    await open('#/building-blocks/in-use?type=skill');
    const section = (
      await screen.findByRole('heading', { level: 2, name: /^Utkast og andre ferdigheter/ })
    ).closest('section') as HTMLElement;
    const draft = within(section).getByRole('link', { name: 'Svare på innsynskrav' });
    expect(within(draft.closest('li') as HTMLElement).getByText('Utkast')).toBeTruthy();
    expect(
      within(section).getByRole('link', { name: 'Sortere post etter saksområde' }),
    ).toBeTruthy();
    expect(within(section).queryByRole('link', { name: 'Skrive vedtaksbrev' })).toBeNull();
    const shared = within(section).getByRole('link', { name: 'Skrive tilsynsrapport' });
    expect(shared.getAttribute('href')).toBe(
      '#/building-blocks/skill/skrive-tilsynsrapport?owner=999666555',
    );

    window.location.hash = draft.getAttribute('href') ?? '';
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Svare på innsynskrav' }),
    ).toBeTruthy();
    window.location.hash = shared.getAttribute('href') ?? '';
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Skrive tilsynsrapport' }),
    ).toBeTruthy();
  });
});

describe('a step flow in Byggeklosser', () => {
  const flow = exampleBlocks.find((b) => b.id === 'postruting') as CatalogItem;
  const stepType: CatalogItem = { ...flow, id: 'call-operation@1', name: 'Kall en operasjon' };

  it('opens an own flow in the step-flow editor under Byggeklosser', async () => {
    await open('#/building-blocks/step_flow/postruting');
    await screen.findByRole('heading', { level: 1, name: 'Postruting' });
    expect(screen.getByRole('link', { name: 'Åpne i stegflyteditoren' }).getAttribute('href')).toBe(
      '#/building-blocks/step_flow/postruting/edit',
    );
  });

  it('shows an own step flow as a read-only diagram and as YAML inside Byggeklosser', async () => {
    await open('#/building-blocks/step_flow/postruting/diagram');
    await screen.findByRole('heading', { level: 1, name: 'Postruting' });
    expect((await screen.findAllByText('Klassifiser')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Legg til steg/ })).toBeNull();
    window.location.hash = '#/building-blocks/step_flow/postruting/yaml';
    const yaml = await screen.findByRole('region', { name: 'Stegflyten som YAML' });
    expect(yaml.textContent).toContain('kind: StepFlow');
    expect(yaml.textContent).toContain('id: klassifiser');
  });

  it('shows a Digdir step flow as a diagram and its YAML from the published definition', async () => {
    const definition = {
      ...exampleStepFlow.latest.definition,
      metadata: { id: 'sf-hoering', name: 'Høringsoppsummering', version: 3 },
    };
    await renderAt(
      '#/building-blocks/step_flow/sf-hoering',
      mockFetch(undefined, undefined, undefined, undefined, {
        features: {
          blocks: {
            flowDefinitions: {
              'sf-hoering': {
                id: 'sf-hoering',
                owner: 'digdir',
                version: 3,
                publishedAt: '2026-10-01T10:00:00Z',
                yaml: 'kind: StepFlow\nmetadata:\n  id: sf-hoering # as published\n',
                definition,
              },
            },
          },
        },
      }),
    );
    await screen.findByRole('heading', { level: 1, name: 'Høringsoppsummering' });
    expect(screen.getByRole('tab', { name: 'Diagram' }).getAttribute('aria-selected')).toBe('true');
    expect((await screen.findAllByText('Klassifiser')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Åpne i stegflyteditoren' })).toBeNull();
    window.location.hash = '#/building-blocks/step_flow/sf-hoering/yaml';
    const yaml = await screen.findByRole('region', { name: 'Stegflyten som YAML' });
    expect(yaml.textContent).toContain('id: sf-hoering # as published');
  });

  it('hides Diagram and YAML on a flow the API does not show, without blaming the publisher', async () => {
    await open('#/building-blocks/step_flow/sf-hoering/diagram');
    await screen.findByRole('heading', { level: 1, name: 'Høringsoppsummering' });
    await waitFor(() =>
      expect(screen.getAllByRole('tab').map((x) => x.textContent)).toEqual([
        'Om',
        'Brukes av',
        'Versjoner',
      ]),
    );
    expect(screen.queryByText(/Utgiveren har ikke delt/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers Bruk i en tjeneste only on a flow that is in use or our own, not one still in the catalogue', async () => {
    await open('#/building-blocks/step_flow/sf-hoering');
    await screen.findByRole('heading', { level: 1, name: 'Høringsoppsummering' });
    expect(screen.queryByRole('button', { name: 'Bruk i en tjeneste' })).toBeNull();
  });

  it('offers Bruk i en tjeneste on a step flow, which puts it in a service draft', async () => {
    await open('#/building-blocks/step_flow/postruting/used-by');
    await screen.findByRole('heading', { level: 1, name: 'Postruting' });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk i en tjeneste' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: /Postruting/ })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Koble til tjenesten' })).toBeTruthy();
  });

  it('shows no Norwegian close button on the use-in-service dialog for an English user', async () => {
    await renderAt(
      '#/building-blocks/step_flow/postruting/used-by',
      mockFetch(undefined, undefined, undefined, undefined, {
        features: { preferences: { language: 'en' } },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Use in a service' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: /Lukk/ })).toBeNull();
  });

  it('gives a step type no link to the step-flow editor', async () => {
    await open(`#/building-blocks/step_flow/${encodeURIComponent(stepType.id)}`, {
      items: [...exampleBlocks, stepType],
    });
    await screen.findByRole('heading', { level: 1, name: 'Kall en operasjon' });
    expect(screen.queryByRole('link', { name: 'Åpne i stegflyteditoren' })).toBeNull();
  });

  it('sends the old step-flow editor address to the editor under Byggeklosser', async () => {
    await open('#/step-flows/postruting?flyt=sak');
    await waitFor(() =>
      expect(window.location.hash).toBe('#/building-blocks/step_flow/postruting/edit?flyt=sak'),
    );
  });

  it('sends a hyphenated kind in the address to the block, so step-flow links are not dead', async () => {
    await open('#/building-blocks/step-flow/postruting');
    await waitFor(() =>
      expect(window.location.hash).toBe('#/building-blocks/step_flow/postruting'),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Postruting' })).toBeTruthy();
  });
});

describe('Byggeklosser: modell, verktøy og fart', () => {
  const pricedFetch = (options: BuildingBlocksMockOptions = {}) =>
    mockFetch(
      undefined,
      undefined,
      [
        {
          id: 'aivar/borealis-27b',
          residency: 'norway',
          capabilities: [],
          price: { inputPerThousand: 0.02, outputPerThousand: 0.08 },
        },
      ],
      undefined,
      { features: { buildingBlocks: options } },
    );

  it('shows the model price per 1 000 tokens from /models', async () => {
    await renderAt('#/building-blocks/model/aivar%2Fborealis-27b', pricedFetch());
    expect(await screen.findByRole('heading', { level: 2, name: 'Pris' })).toBeTruthy();
    expect(screen.getByText('0,02 kr per 1 000 tokens')).toBeTruthy();
    expect(screen.getByText('0,08 kr per 1 000 tokens')).toBeTruthy();
  });

  it('shows who made and runs a model from /models and when it was taken into use from the block', async () => {
    const borealis = exampleBlocks.find((b) => b.id === 'aivar/borealis-27b') as CatalogItem;
    await renderAt(
      '#/building-blocks/model/aivar%2Fborealis-27b',
      mockFetch(
        undefined,
        undefined,
        [
          {
            id: 'aivar/borealis-27b',
            residency: 'norway',
            capabilities: [],
            maker: 'AIVAR',
            operator: { name: 'AIVAR', region: 'Norge' },
          } as never,
        ],
        undefined,
        {
          features: {
            buildingBlocks: {
              items: [
                ...exampleBlocks.filter((b) => b !== borealis),
                {
                  ...borealis,
                  adoptedAt: '2026-09-02T10:00:00Z',
                  adoptedByName: 'Kari Nordmann',
                } as CatalogItem,
              ],
            },
          },
        },
      ),
    );
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    const facts = screen
      .getByRole('heading', { name: 'Om modellen' })
      .closest('section') as HTMLElement;
    expect(await within(facts).findByText('Laget av')).toBeTruthy();
    expect(within(facts).getByText('Drives av')).toBeTruthy();
    expect(within(facts).getByText('AIVAR, Norge')).toBeTruthy();
    expect(within(facts).getByText(/2\. september 2026 av Kari Nordmann/)).toBeTruthy();
  });

  it('leaves out who made and runs a model while the API does not say', async () => {
    await open('#/building-blocks/model/aivar%2Fborealis-27b');
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    expect(screen.queryByText('Laget av')).toBeNull();
    expect(screen.queryByText('Drives av')).toBeNull();
  });

  it('has a single Byggeklosser back link instead of a slash breadcrumb', async () => {
    await open('#/building-blocks/model/aivar%2Fborealis-27b');
    await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' });
    expect(screen.queryByRole('navigation', { name: /brødsmule|breadcrumb/i })).toBeNull();
    expect(
      within(screen.getByRole('main'))
        .getByRole('link', { name: 'Byggeklosser' })
        .getAttribute('href'),
    ).toBe('#/building-blocks');
  });

  it('shows the block without waiting for the slow overview', async () => {
    const fetch = blocksFetch();
    await renderAt('#/building-blocks/model/aivar%2Fborealis-27b', (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('/overview')
        ? new Promise<Response>(() => undefined)
        : fetch(input, init);
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Borealis-27B' })).toBeTruthy();
  });

  const arkiv = {
    id: 'arkiv',
    name: 'Arkivsøk',
    endpoint: 'https://mcp.testetaten.example.no/mcp',
    lastSync: { at: '2026-11-12T06:45:00Z', ok: true },
    toolDetails: [
      {
        name: 'arkiv.sok',
        description: 'Søk i saksarkivet',
        state: 'approved' as const,
        changes: false,
      },
      {
        name: 'arkiv.opprett',
        description: 'Opprett journalpost',
        state: 'pending' as const,
        since: '2026-11-12T06:45:00Z',
        changes: true,
      },
    ],
  };
  const toolFetch = (
    connections: ToolConnectionDetail[] = [arkiv],
    extra: { failSync?: boolean } = {},
  ) =>
    mockFetch(undefined, undefined, undefined, undefined, {
      features: { blocks: { connections, ...extra } },
    });

  it('shows the connection of an own tool with its last sync and syncs it on request', async () => {
    await renderAt('#/building-blocks/tool/arkiv', toolFetch());
    await screen.findByRole('heading', { level: 1, name: 'Saksarkivet' });
    expect(await screen.findByText('Sist synkronisert')).toBeTruthy();
    expect(screen.getByText('https://mcp.testetaten.example.no/mcp')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Synkroniser nå' }));
    expect(
      await screen.findByText('Synkronisert. 1 verktøy er godkjent, 1 venter på godkjenning.'),
    ).toBeTruthy();
  });

  it('says so when the last sync of a tool failed', async () => {
    await renderAt(
      '#/building-blocks/tool/arkiv',
      toolFetch([
        {
          ...arkiv,
          lastSync: {
            at: '2026-11-12T06:45:00Z',
            ok: false,
            message: 'Tidsavbrudd etter 30 sekunder.',
          },
        },
      ]),
    );
    expect(
      await screen.findByText(/Saksarkivet svarte ikke ved siste synkronisering/),
    ).toBeTruthy();
    expect(screen.getByText(/Tidsavbrudd etter 30 sekunder\./)).toBeTruthy();
  });

  it('approves and withdraws single tools of a connection with a reason', async () => {
    await renderAt('#/building-blocks/tool/arkiv', toolFetch());
    const pending = (await screen.findByRole('checkbox', {
      name: /arkiv\.opprett/,
    })) as HTMLInputElement;
    const approved = screen.getByRole('checkbox', { name: /arkiv\.sok/ }) as HTMLInputElement;
    expect(approved.checked).toBe(true);
    expect(pending.checked).toBe(false);
    expect(screen.getByText('1 av 2 godkjent')).toBeTruthy();
    expect(screen.getByText('Endrer data')).toBeTruthy();
    fireEvent.click(pending);
    fireEvent.click(approved);
    const bar = screen.getByRole('region', { name: 'Ulagrede endringer' });
    fireEvent.change(within(bar).getByLabelText('Hvorfor endrer du dette?'), {
      target: { value: 'Trengs for vedtaksutkast' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText(/Endringen står i Logg, Endringer\./)).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole('checkbox', { name: /arkiv\.opprett/ }) as HTMLInputElement).checked,
      ).toBe(true),
    );
    expect((screen.getByRole('checkbox', { name: /arkiv\.sok/ }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('approves a pending tool from the integrations list while the connection has no per-tool state, and cannot withdraw one yet', async () => {
    const calls: { path: string; body: string }[] = [];
    const fetch = mockFetch(undefined, undefined, undefined, undefined, {
      integrations: {
        connections: [
          {
            id: 'arkiv',
            name: 'Arkivsøk',
            endpoint: 'https://mcp.testetaten.example.no/mcp',
            version: '1.0',
            allow: [{ host: 'mcp.testetaten.example.no' }],
            auth: null,
            tools: [{ name: 'arkiv.sok', description: 'Søk i saksarkivet' }],
            pending: [{ name: 'arkiv.opprett', description: 'Opprett journalpost' }],
          },
        ],
        traces: { enabled: true, content: false },
      },
      features: {
        blocks: {
          connections: [
            {
              id: 'arkiv',
              name: 'Arkivsøk',
              endpoint: 'https://mcp.testetaten.example.no/mcp',
              version: '1.0',
              tools: ['arkiv.sok'],
              lastSync: { at: '2026-11-12T06:45:00Z', ok: true },
            },
          ],
        },
      },
    });
    await renderAt('#/building-blocks/tool/arkiv', (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === 'POST') calls.push({ path: url, body: String(init.body) });
      return fetch(input, init);
    });
    const pending = (await screen.findByRole('checkbox', {
      name: /arkiv\.opprett/,
    })) as HTMLInputElement;
    const approved = screen.getByRole('checkbox', { name: /arkiv\.sok/ }) as HTMLInputElement;
    expect(approved.checked).toBe(true);
    expect(approved.disabled).toBe(true);
    expect(
      screen.getByText('Et godkjent verktøy kan ikke trekkes tilbake herfra ennå.'),
    ).toBeTruthy();
    fireEvent.click(pending);
    const bar = screen.getByRole('region', { name: 'Ulagrede endringer' });
    fireEvent.change(within(bar).getByLabelText('Hvorfor endrer du dette?'), {
      target: { value: 'Trengs for vedtaksutkast' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText(/Endringen står i Logg, Endringer\./)).toBeTruthy();
    expect(calls).toEqual([
      {
        path: expect.stringMatching(/\/tool-connections\/arkiv\/approve$/),
        body: JSON.stringify({ tool: 'arkiv.opprett' }),
      },
    ]);
  });

  it('says when and by whom a tool was connected', async () => {
    await renderAt(
      '#/building-blocks/tool/arkiv',
      toolFetch([{ ...arkiv, connectedAt: '2026-10-14T09:00:00Z', connectedByName: 'Per Hansen' }]),
    );
    const label = await screen.findByText('Koblet til', { selector: 'dt' });
    expect(label.nextElementSibling?.textContent).toBe('14. oktober 2026 av Per Hansen');
  });

  it('says a tool changed meanwhile and reloads when the API no longer finds it pending', async () => {
    const base = toolFetch();
    let lists = 0;
    await renderAt('#/building-blocks/tool/arkiv', (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/tool-connections') && !init?.method) lists += 1;
      if (url.endsWith('/approve'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'urn:genai:problem:tool-not-found',
              title: 'No such tool',
              status: 404,
            }),
            { status: 404, headers: { 'content-type': 'application/problem+json' } },
          ),
        );
      return base(input, init);
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: /arkiv\.opprett/ }));
    const before = lists;
    const bar = screen.getByRole('region', { name: 'Ulagrede endringer' });
    fireEvent.change(within(bar).getByLabelText('Hvorfor endrer du dette?'), {
      target: { value: 'Trengs for vedtaksutkast' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre' }));
    expect(
      await screen.findByText(
        'Verktøyet arkiv.opprett er endret siden du åpnet siden. Vi har hentet listen på nytt.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(lists).toBeGreaterThan(before));
    expect(screen.getByText(/Verktøyet arkiv\.opprett er endret/)).toBeTruthy();
  });

  it('Forkast puts the tool approvals back as they were', async () => {
    await renderAt('#/building-blocks/tool/arkiv', toolFetch());
    fireEvent.click(await screen.findByRole('checkbox', { name: /arkiv\.opprett/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Forkast' }));
    expect(screen.queryByRole('region', { name: 'Ulagrede endringer' })).toBeNull();
    expect(
      (screen.getByRole('checkbox', { name: /arkiv\.opprett/ }) as HTMLInputElement).checked,
    ).toBe(false);
  });
});
