// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { Demos } from './screens/Demos';
import { commandLine, describeCommand, parseCommands } from './screens/demos/commands';
import { demosMock, exampleDemoData } from './screens/demos/mock';
import { translator } from './i18n';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};
afterEach(() => {
  cleanup();
  window.location.hash = '';
});
beforeAll(() => {
  URL.createObjectURL = () => 'blob:demo';
  URL.revokeObjectURL = () => undefined;
});

interface Sent {
  method: string;
  path: string;
  reason: string | null;
  ifMatch: string | null;
  body: Record<string, unknown>;
}

const studio = (recorder: 'job' | 'scheduled' | 'workflow' = 'job', data = exampleDemoData()) => {
  const routes = demosMock(
    data,
    'operator:Lise Dahl',
    () => new Date('2026-11-18T10:00:00Z'),
    recorder,
  );
  const sent: Sent[] = [];
  const api = createApiClient({
    baseUrl: '/api',
    token: () => 'ops',
    fetch: async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname.replace(/^\/api/, '');
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const raw = headers.get('change-reason');
      const reason = raw === null ? null : decodeURIComponent(raw);
      const body = () => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sent.push({
        method,
        path,
        reason,
        ifMatch: headers.get('if-match'),
        body: method === 'GET' ? {} : body(),
      });
      const reply = await routes(path, method, reason && reason.length >= 10 ? reason : null, body);
      return reply ?? new Response('{}', { status: 404 });
    },
  });
  return { api, sent, writes: () => sent.filter((s) => s.method !== 'GET') };
};

const confirmWithReason = async (button: string, reason = 'ny versjon av portalen') => {
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), { target: { value: reason } });
  fireEvent.click(within(dialog).getByRole('button', { name: button }));
};

describe('the demo library', () => {
  it('shows a demo being recorded with its progress and a link to follow it', async () => {
    const { api } = studio();
    render(<Demos api={api} />);

    const card = (
      await screen.findByRole('link', { name: 'Klarspråk for saksbehandlere' })
    ).closest('li') as HTMLElement;

    expect(within(card).getByText('Tas opp')).toBeTruthy();
    expect(within(card).getByText(/Opptak pågår, steg 1 av 3/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Følg opptaket' }).getAttribute('href')).toBe(
      '#/demos?recording=r-klarsprak-1',
    );
  });

  it('can be filtered to one audience', async () => {
    const { api } = studio();
    render(<Demos api={api} />);
    await screen.findByRole('link', { name: 'Rundtur i portalen' });

    fireEvent.change(screen.getByLabelText('Målgruppe'), { target: { value: 'municipality' } });

    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Klarspråk for saksbehandlere',
      'Sett opp en tjeneste med Altinn-innlogging',
    ]);
  });

  it('links a failed demo to what failed', async () => {
    const { api } = studio();
    render(<Demos api={api} />);

    const card = (await screen.findByRole('link', { name: 'Følg en kjøring i sporingen' })).closest(
      'li',
    ) as HTMLElement;

    expect(within(card).getByRole('link', { name: 'Se hva som feilet' }).getAttribute('href')).toBe(
      '#/demos?recording=r-tracing-2',
    );
  });
});

describe('recording a demo again', () => {
  it('asks for a reason, queues the recording and opens its progress', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} demo="portal-tour" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ta opp på nytt' }));
    await confirmWithReason('Start opptaket');

    await waitFor(() =>
      expect(window.location.hash).toMatch(/^#\/demos\?recording=r-portal-tour-/),
    );
    expect(writes()).toMatchObject([
      {
        method: 'POST',
        path: '/operator/demos/portal-tour/recordings',
        reason: 'ny versjon av portalen',
      },
    ]);
  });

  it('points at the demos workflow instead where recordings are not made by a job', async () => {
    const { api } = studio('workflow');
    render(<Demos api={api} demo="portal-tour" />);

    expect(await screen.findByText(/Opptak gjøres med arbeidsflyten demos i GitHub/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ta opp på nytt' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Rediger' }).getAttribute('href')).toBe(
      '#/demos?edit=portal-tour',
    );
  });

  it('says so when the demo already has a recording that has not finished', async () => {
    const { api } = studio();
    render(<Demos api={api} demo="klarsprak" />);

    expect(await screen.findByText(/Opptak pågår, steg 1 av 3/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Ta opp på nytt' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('a recording in progress', () => {
  it('shows each step as done, in progress or waiting, with the latest screenshot', async () => {
    const { api } = studio();
    render(<Demos api={api} params={new URLSearchParams('recording=r-klarsprak-1')} />);

    const steps = await screen.findByRole('heading', { name: 'Steg' });
    const list = steps.closest('section') as HTMLElement;
    const items = within(list).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Ferdig'),
      expect.stringContaining('Pågår'),
      expect.stringContaining('Venter'),
    ]);
    expect(await screen.findByRole('img', { name: 'Skjermbilde etter steg 1' })).toBeTruthy();
  });

  it('cancels with a reason', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('recording=r-klarsprak-1')} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Avbryt opptaket' }));
    await confirmWithReason('Avbryt opptaket', 'feil versjon av demoen');

    expect(await screen.findByText('Opptaket ble avbrutt')).toBeTruthy();
    expect(writes()).toMatchObject([
      {
        method: 'POST',
        path: '/operator/recordings/r-klarsprak-1/cancel',
        reason: 'feil versjon av demoen',
      },
    ]);
  });
});

describe('a failed recording', () => {
  it('shows the step, what the recorder looked for in words, what it found and a way to edit the step', async () => {
    const { api } = studio();
    render(<Demos api={api} params={new URLSearchParams('recording=r-tracing-2')} />);

    expect(
      await screen.findByRole('heading', { name: 'Opptaket feilet på steg 4 av 5' }),
    ).toBeTruthy();
    expect(await screen.findByText('Åpne kjøringen for å se stegene.')).toBeTruthy();
    expect(screen.getByText('lenken med navnet «Åpne kjøringen»')).toBeTruthy();
    expect(
      await screen.findByRole('img', { name: 'Skjermbilde av det opptakeren fant på steg 4' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Rediger steget' }).getAttribute('href')).toBe(
      '#/demos?edit=tracing&step=4',
    );
  });
});

describe('the demo editor', () => {
  it('saves the steps with a reason as the next version of the demo', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    const say = await screen.findAllByLabelText('Fortelling');
    fireEvent.change(say[0] as HTMLElement, { target: { value: 'En kortere åpning.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'kortere åpning i steg en');

    await waitFor(() => expect(window.location.hash).toBe('#/demos?demo=portal-tour'));
    const [save] = writes();
    expect(save).toMatchObject({
      method: 'PUT',
      path: '/operator/demos/portal-tour',
      ifMatch: '1',
    });
    expect((save?.body.steps as { say: string }[])[0]?.say).toBe('En kortere åpning.');
    expect((save?.body.steps as { do?: string[][] }[])[1]?.do?.[0]).toEqual([
      'find',
      'role',
      'link',
      'click',
      '--name',
      'Tjenester',
    ]);
  });

  it('refuses to save a line of clicks that is not a command', async () => {
    const { api } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    const lines = await screen.findAllByLabelText(/Klikk og venting/);
    fireEvent.change(lines[1] as HTMLElement, { target: { value: 'klikk på Tjenester' } });

    expect(
      await screen.findByText(
        'Linje 1 i steg 2 er ikke en kommando som [find, role, button, click].',
      ),
    ).toBeTruthy();
  });

  it('shows the demo as YAML, and an edit there changes the steps', async () => {
    const { api } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vis YAML' }));

    const yaml = screen.getByLabelText('Demoen som YAML') as HTMLTextAreaElement;
    expect(yaml.value).toContain('title: Rundtur i portalen');
    fireEvent.change(yaml, {
      target: { value: yaml.value.replace('Portalen er der', 'Portalen er stedet der') },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Vis skjema' }));

    expect(
      ((await screen.findAllByLabelText('Fortelling'))[0] as HTMLTextAreaElement).value,
    ).toContain('Portalen er stedet der');
  });

  it('saves changes before it tries a step, and queues a trial up to that step', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    const say = await screen.findAllByLabelText('Fortelling');
    fireEvent.change(say[1] as HTMLElement, { target: { value: 'Tjenester viser alt.' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Prøv dette steget' })[1] as HTMLElement);
    await confirmWithReason('Lagre og prøv', 'prøver nytt steg to');

    await waitFor(() => expect(window.location.hash).toMatch(/recording=/));
    expect(writes().map((w) => [w.method, w.path, w.body.upTo])).toEqual([
      ['PUT', '/operator/demos/portal-tour', undefined],
      ['POST', '/operator/demos/portal-tour/recordings', 2],
    ]);
  });

  it('opens at the step a failed recording points to', async () => {
    const { api } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=tracing&step=4')} />);

    const field = await screen.findByDisplayValue('Åpne kjøringen for å se stegene.');
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('cannot try a step where recordings are not made by a job', async () => {
    const { api } = studio('workflow');
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    const buttons = await screen.findAllByRole('button', { name: 'Prøv dette steget' });
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('starts a new demo from the default voice and makes its address from the title', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('new=1')} />);

    fireEvent.change(await screen.findByLabelText('Tittel'), {
      target: { value: 'Byggesak på fem minutter' },
    });
    fireEvent.change(screen.getByLabelText('Fortelling'), { target: { value: 'Vi starter her.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'første versjon av demoen');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      path: '/operator/demos/byggesak-pa-fem-minutter',
      ifMatch: '0',
      body: { voice: 'nb-NO-PernilleNeural', title: 'Byggesak på fem minutter' },
    });
  });
});

describe('the demo settings', () => {
  it('saves with a reason over the version that was read', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('settings=1')} />);

    fireEvent.change(await screen.findByLabelText('Lagringstid (dager)'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre innstillingene' }));
    await confirmWithReason('Lagre innstillingene', 'kortere lagringstid for opptak');

    expect(await screen.findByText('Innstillingene er lagret.')).toBeTruthy();
    expect(writes()).toMatchObject([
      { method: 'PUT', path: '/operator/demo-settings', ifMatch: '1', body: { retentionDays: 30 } },
    ]);
  });

  it('plays a sample of the default voice', async () => {
    const { api } = studio();
    render(<Demos api={api} params={new URLSearchParams('settings=1')} />);

    expect(await screen.findByLabelText('Prøve av nb-NO-PernilleNeural')).toBeTruthy();
  });

  it('refuses a test organisation that is not a nine-digit org number', async () => {
    const { api } = studio();
    render(<Demos api={api} params={new URLSearchParams('settings=1')} />);

    fireEvent.change(await screen.findByLabelText(/Testvirksomhet/), { target: { value: '123' } });

    expect(
      (screen.getByRole('button', { name: 'Lagre innstillingene' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('the scheduled recorder', () => {
  it('lets a recording be queued and says the recorder picks it up within about five minutes', async () => {
    const { api } = studio('scheduled');
    const { unmount } = render(<Demos api={api} demo="portal-tour" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ta opp på nytt' }));
    await confirmWithReason('Start opptaket');
    await waitFor(() => expect(window.location.hash).toMatch(/recording=/));
    unmount();
    render(<Demos api={api} demo="portal-tour" />);

    expect(
      await screen.findByText(
        /Venter på opptakeren, som henter opptaket innen om lag fem minutter/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Opptak gjøres med arbeidsflyten demos i GitHub/)).toBeNull();
  });

  it('tells the person following a queued recording that the recorder looks every five minutes', async () => {
    const { api } = studio('scheduled');
    const started = await api.requestRecording('portal-tour', 'ny versjon av portalen');
    const stillQueued = { ...api, recording: () => Promise.resolve(started) };
    render(<Demos api={stillQueued} params={new URLSearchParams(`recording=${started.id}`)} />);

    expect(
      await screen.findByText(/Opptakeren ser etter nye opptak hvert femte minutt/),
    ).toBeTruthy();
  });

  it('lets a step be tried in the editor where the scheduled recorder records', async () => {
    const { api } = studio('scheduled');
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    const tries = await screen.findAllByRole('button', { name: 'Prøv dette steget' });

    expect(tries.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.queryByText(/Prøving krever opptak fra konsollet/)).toBeNull();
  });

  it('names the demo-recorder workflow in the settings', async () => {
    const { api } = studio('scheduled');
    render(<Demos api={api} params={new URLSearchParams('settings=1')} />);

    expect(
      await screen.findByText(/Opptakene gjøres av arbeidsflyten demo-recorder i GitHub/),
    ).toBeTruthy();
  });
});

describe('choosing a voice', () => {
  const options = (select: HTMLElement) =>
    within(select)
      .getAllByRole('option')
      .map((o) => [(o as HTMLOptionElement).value, o.textContent]);

  it('lists the known voices by name, language and gender, and the language follows the voice', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    const voice = await screen.findByLabelText('Stemme');
    expect(options(voice)).toHaveLength(9);
    expect(options(voice)[0]).toEqual(['nb-NO-PernilleNeural', 'Pernille (norsk bokmål, kvinne)']);
    expect(options(voice)).toEqual(
      expect.arrayContaining([
        ['nb-NO-PernilleNeural', 'Pernille (norsk bokmål, kvinne)'],
        ['nb-NO-FinnNeural', 'Finn (norsk bokmål, mann)'],
        ['en-GB-RyanNeural', 'Ryan (britisk engelsk, mann)'],
      ]),
    );
    fireEvent.change(voice, { target: { value: 'en-GB-SoniaNeural' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'engelsk stemme for besøket');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({ voice: 'en-GB-SoniaNeural', language: 'en-GB' });
  });

  it('shows a stored voice outside the list as its id and keeps it and the language on save', async () => {
    const data = exampleDemoData();
    data.demos = data.demos.map((d) =>
      d.id === 'portal-tour' ? { ...d, voice: 'de-DE-KatjaNeural', language: 'de-DE' } : d,
    );
    const { api, writes } = studio('job', data);
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    const voice = (await screen.findByLabelText('Stemme')) as HTMLSelectElement;
    expect(voice.value).toBe('de-DE-KatjaNeural');
    expect(options(voice)[0]).toEqual(['de-DE-KatjaNeural', 'de-DE-KatjaNeural']);
    fireEvent.change((await screen.findAllByLabelText('Fortelling'))[0] as HTMLElement, {
      target: { value: 'Eine kurze Einleitung.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'kortere åpning i steg en');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({ voice: 'de-DE-KatjaNeural', language: 'de-DE' });
  });

  it('lets a stored voice outside the list be chosen again after picking another, with its language', async () => {
    const data = exampleDemoData();
    data.demos = data.demos.map((d) =>
      d.id === 'portal-tour' ? { ...d, voice: 'de-DE-KatjaNeural', language: 'de-DE' } : d,
    );
    const { api, writes } = studio('job', data);
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    const voice = await screen.findByLabelText('Stemme');
    fireEvent.change(voice, { target: { value: 'en-GB-RyanNeural' } });
    fireEvent.change(voice, { target: { value: 'de-DE-KatjaNeural' } });
    fireEvent.change((await screen.findAllByLabelText('Fortelling'))[0] as HTMLElement, {
      target: { value: 'Eine kurze Einleitung.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'kortere åpning i steg en');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({ voice: 'de-DE-KatjaNeural', language: 'de-DE' });
  });

  it('picks the default voice in the settings from the same list', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('settings=1')} />);

    fireEvent.change(await screen.findByLabelText('Standardstemme'), {
      target: { value: 'nb-NO-FinnNeural' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre innstillingene' }));
    await confirmWithReason('Lagre innstillingene', 'mannsstemme som standard');

    expect(await screen.findByText('Innstillingene er lagret.')).toBeTruthy();
    expect(writes()).toMatchObject([{ body: { voice: 'nb-NO-FinnNeural' } }]);
  });
});

describe('recorder commands', () => {
  const t = translator('nb');

  it('reads a find by role and name as words', () => {
    expect(describeCommand(['find', 'role', 'button', 'click', '--name', 'Endre oppsett'], t)).toBe(
      'knappen med navnet «Endre oppsett»',
    );
    expect(describeCommand(['wait', '--text', 'Hva vil du prøve?'], t)).toBe(
      'at teksten «Hva vil du prøve?» skulle vises',
    );
  });

  it('writes a command so it reads back the same', () => {
    for (const command of [
      ['find', 'role', 'button', 'click', '--name', 'Endre oppsett'],
      ['wait', '--text', 'Hva vil du prøve?', '--timeout', '30000'],
      ['select', 'select[id$="-svc"]', 'smoke'],
      ['fill', '#q', 'Navn: Kari, # 2'],
      ['open', 'https://portal.genki-test.digdir.cloud/#/playground'],
    ])
      expect(parseCommands(commandLine(command))).toEqual({ ok: true, commands: [command] });
  });
});
