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
    render(<Demos api={api} demo="tracing" />);

    expect(
      (await screen.findByRole('link', { name: 'Se hva som feilet' })).getAttribute('href'),
    ).toBe('#/demos?recording=r-tracing-2');
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
        body: {},
      },
    ]);
    expect(writes()[0]?.body).toEqual({});
  });

  it('records without AI unless someone approves the shown cost, and sends the approved cap', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} demo="portal-tour" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ta opp på nytt' }));
    const dialog = await screen.findByRole('dialog');
    const approve = within(dialog).getByRole('checkbox', {
      name: /^Godkjenn KI-kostnad på høyst \d+ USD/,
    });
    expect((approve as HTMLInputElement).checked).toBe(false);
    fireEvent.click(approve);
    await confirmWithReason('Start opptaket');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ costCapUsd: expect.any(Number) });
  });

  it('refuses to queue a demo read by a model voice until the cost is approved', async () => {
    const data = exampleDemoData();
    data.demos = data.demos.map((d) => (d.id === 'portal-tour' ? { ...d, voice: 'cedar' } : d));
    const { api, writes } = studio('job', data);
    render(<Demos api={api} demo="portal-tour" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ta opp på nytt' }));
    await confirmWithReason('Start opptaket');

    expect(await screen.findByText('Godkjenn kostnaden først.')).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('points at the demos workflow instead where recordings are not made by a job', async () => {
    const { api } = studio('workflow');
    render(<Demos api={api} demo="portal-tour" />);

    expect(await screen.findByText(/Opptak gjøres med arbeidsflyten demos i GitHub/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ta opp på nytt' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Rediger steg' }).getAttribute('href')).toBe(
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

    fireEvent.click(await screen.findByRole('button', { name: 'Stopp opptaket' }));
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

  it('keeps a title card, a closing card, chapters and focus written in YAML when it saves', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vis YAML' }));

    const yaml = screen.getByLabelText('Demoen som YAML') as HTMLTextAreaElement;
    const edited = yaml.value
      .replace('steps:', 'intro:\n  title: Genki\noutro:\n  title: Takk\nsteps:')
      .replace(/( {2}- say: [^\n]*\n)/, '$1    chapter: Hva er Genki\n    focus: [role, table]\n');
    fireEvent.change(yaml, { target: { value: edited } });
    fireEvent.click(screen.getByRole('button', { name: 'Vis skjema' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'tittelkort og kapitler');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({
      intro: { title: 'Genki' },
      outro: { title: 'Takk' },
      steps: expect.arrayContaining([
        expect.objectContaining({ chapter: 'Hva er Genki', focus: ['role', 'table'] }),
      ]),
    });
  });

  it('keeps respellings, spoken lines, music, example data and words to hide written in YAML when it saves', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vis YAML' }));

    const yaml = screen.getByLabelText('Demoen som YAML') as HTMLTextAreaElement;
    const edited = yaml.value
      .replace(
        'steps:',
        'respell:\n  elevenlabs:\n    Genki: Genn-ki\nmusic: pulse\nexampleData: true\nscrub: [Intern]\nsteps:',
      )
      .replace(/( {2}- say: [^\n]*\n)/, '$1    spoken:\n      elevenlabs: Genn-ki\n');
    fireEvent.change(yaml, { target: { value: edited } });
    fireEvent.click(screen.getByRole('button', { name: 'Vis skjema' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'uttale og musikk');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({
      respell: { elevenlabs: { Genki: 'Genn-ki' } },
      music: 'pulse',
      exampleData: true,
      scrub: ['Intern'],
      steps: expect.arrayContaining([
        expect.objectContaining({ spoken: { elevenlabs: 'Genn-ki' } }),
      ]),
    });
  });

  it("keeps a step's scene and page and the demo's colour scheme written in YAML when it saves", async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vis YAML' }));

    const yaml = screen.getByLabelText('Demoen som YAML') as HTMLTextAreaElement;
    const edited = yaml.value
      .replace('steps:', 'colorScheme: light\nsteps:')
      .replace(
        /( {2}- say: [^\n]*\n)/,
        '$1    page: /#/developer/frontends\n    scene:\n      template: screen\n      title: Én tjeneste, mange innganger\n',
      );
    fireEvent.change(yaml, { target: { value: edited } });
    fireEvent.click(screen.getByRole('button', { name: 'Vis skjema' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'scener og sider');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({
      colorScheme: 'light',
      steps: expect.arrayContaining([
        expect.objectContaining({
          page: '/#/developer/frontends',
          scene: { template: 'screen', title: 'Én tjeneste, mange innganger' },
        }),
      ]),
    });
  });

  it('saves the colours the demo is recorded in', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    fireEvent.change(await screen.findByLabelText('Farger i opptaket'), {
      target: { value: 'light' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'lyse farger som i filmen');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body.colorScheme).toBe('light');
  });

  it('queues a trial of a model-voice demo without asking for approval', async () => {
    const data = exampleDemoData();
    data.demos = data.demos.map((d) => (d.id === 'portal-tour' ? { ...d, voice: 'cedar' } : d));
    const { api, writes } = studio('job', data);
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Prøv dette steget' }))[0] as HTMLElement,
    );
    await confirmWithReason('Prøv steget', 'prøver første steg');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ upTo: 1 });
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

  it('says on the library card of a queued film that the recorder picks it up within about five minutes', async () => {
    const { api } = studio('scheduled');
    await api.requestRecording('portal-tour', 'ny versjon av portalen');
    render(<Demos api={api} />);

    expect(
      await screen.findByText(
        /Venter på opptakeren, som henter opptaket innen om lag fem minutter/,
      ),
    ).toBeTruthy();
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
  const voices = async (legend = 'Stemme') =>
    within(
      (await screen.findByText(legend, { selector: 'legend, legend *' })).closest(
        'fieldset',
      ) as HTMLElement,
    ).getAllByRole('radio') as HTMLInputElement[];
  const labelOf = (radio: HTMLInputElement) => radio.labels?.[0]?.textContent ?? '';

  it('lists the voices of each provider with gender and language, and the language follows the voice', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    const list = await voices();
    expect(list).toHaveLength(12);
    expect(labelOf(list[0] as HTMLInputElement)).toBe('Pernille');
    expect(list.find((r) => r.value === 'cedar')?.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Azure OpenAI gpt-audio: mann, norsk bokmål')).toBeTruthy();
    expect(screen.getAllByText('Azure Speech: kvinne, norsk bokmål')).toHaveLength(2);
    fireEvent.click(screen.getByRole('radio', { name: /^Sonia/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'engelsk stemme for besøket');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({ voice: 'en-GB-SoniaNeural', language: 'en-GB' });
  });

  it('lists the ElevenLabs voice and «Uten stemme», and a demo without a voice keeps its language', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    expect(await screen.findByText('ElevenLabs: mann, norsk bokmål')).toBeTruthy();
    expect(screen.queryByText('Ikke ennå')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /^Uten stemme/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'bare teksting i denne');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({ voice: 'none', language: 'nb-NO' });
  });

  it('shows a stored voice outside the list by its id and keeps it and the language on save', async () => {
    const data = exampleDemoData();
    data.demos = data.demos.map((d) =>
      d.id === 'portal-tour' ? { ...d, voice: 'de-DE-KatjaNeural', language: 'de-DE' } : d,
    );
    const { api, writes } = studio('job', data);
    render(<Demos api={api} params={new URLSearchParams('edit=portal-tour')} />);

    const list = await voices();
    expect(list[0]?.value).toBe('de-DE-KatjaNeural');
    expect(list[0]?.checked).toBe(true);
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

    fireEvent.click(await screen.findByRole('radio', { name: /^Ryan/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'de-DE-KatjaNeural' }));
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

    await voices('Standardstemme');
    fireEvent.click(screen.getByRole('radio', { name: /^Finn/ }));
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

const openStudio = async (recording = 'r-tour-1') => {
  const tools = studio();
  render(<Demos api={tools.api} params={new URLSearchParams(`recording=${recording}`)} />);
  await within(await screen.findByRole('list', { name: 'Kamera' })).findAllByRole('button');
  return tools;
};

const askDirector = async (instruction: string) => {
  fireEvent.click(screen.getByRole('tab', { name: 'Regissør' }));
  fireEvent.change(screen.getByLabelText('Be om et nytt klipp'), {
    target: { value: instruction },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  return screen.findByRole('region', { name: /^Plan for utgave/ });
};

describe('the studio', () => {
  it('shows the camera keyframes of the edit list on the timeline, at their time in the film', async () => {
    await openStudio();

    expect(
      within(screen.getByRole('list', { name: 'Kamera' }))
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Kamera 1.4×, 0:10: Listen over tjenester',
      'Kamera 1.0×, 0:17: Tilbake til hele siden',
    ]);
    expect(
      within(screen.getByRole('list', { name: 'Tale' })).getByRole('button', {
        name: /^Replikk 2, 0:10/,
      }),
    ).toBeTruthy();
  });

  it("shows how a line was heard back in the inspector, from the recording's scores", async () => {
    await openStudio();

    fireEvent.click(screen.getByRole('button', { name: /^Replikk 2,/ }));

    const facts = screen
      .getByRole('heading', { name: 'Opptak' })
      .closest('.insp-section') as HTMLElement;
    expect(within(facts).getByText('4')).toBeTruthy();
    expect(within(facts).getByText('datasett')).toBeTruthy();
    expect(within(facts).getByText('data')).toBeTruthy();
    expect(within(facts).getByText('3,4 ord/s')).toBeTruthy();
  });

  it('moves the film to a keyframe or a line that is clicked', async () => {
    await openStudio();
    const video = (await screen.findByLabelText(/^Video/)) as HTMLVideoElement;
    let at = 0;
    Object.defineProperty(video, 'currentTime', {
      get: () => at,
      set: (value: number) => void (at = value),
    });

    fireEvent.click(screen.getByRole('button', { name: /^Kamera 1.0×/ }));
    expect(at).toBeCloseTo(16.8);

    fireEvent.click(screen.getByRole('button', { name: /^Replikk 2,/ }));
    expect(at).toBe(9.5);
  });

  it('shows the line that is selected in the inspector', async () => {
    await openStudio();
    expect(screen.getByRole('heading', { name: 'Replikk 1' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Replikk 3,/ }));

    expect(screen.getByRole('heading', { name: 'Replikk 3' })).toBeTruthy();
    expect((screen.getByLabelText('Vist tekst') as HTMLTextAreaElement).value).toBe(
      (screen.getByRole('textbox', { name: 'Vist tekst, replikk 3' }).textContent ?? '').trim(),
    );
  });

  it('keeps the selected line when the film is fetched again after a save', async () => {
    const { sent, writes } = await openStudio();
    const reads = () =>
      sent.filter((s) => s.method === 'GET' && s.path === '/operator/demos/portal-tour').length;
    const before = reads();
    fireEvent.click(screen.getByRole('button', { name: /^Replikk 2,/ }));
    fireEvent.change(screen.getByLabelText('Vist tekst'), {
      target: { value: 'En ny replikk to.' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Lagre manus' }));
    await confirmWithReason('Lagre manus', 'ny tekst i replikk to');

    expect(await screen.findByText(/Manuset er lagret/)).toBeTruthy();
    expect(writes()).toHaveLength(1);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Vist tekst, replikk 2' }).textContent).toBe(
        'En ny replikk to.',
      ),
    );
    expect(screen.getByRole('heading', { name: 'Replikk 2' })).toBeTruthy();
    expect((screen.getByLabelText('Vist tekst') as HTMLTextAreaElement).value).toBe(
      'En ny replikk to.',
    );
  });

  it('sends the instruction with a reason and the approved cap as an edit of the film', async () => {
    const { writes } = await openStudio();
    const plan = await askDirector('Gjør zoomen på Statistikk roligere');
    const make = within(plan).getByRole('button', { name: 'Lag utgave 2' });
    expect((make as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(
      within(plan).getByRole('checkbox', { name: /^Godkjenn KI-kostnad på høyst 1 USD/ }),
    );
    expect((make as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(within(plan).getByLabelText('Begrunnelse'), {
      target: { value: 'roligere kamera i filmen' },
    });
    fireEvent.click(make);

    await waitFor(() =>
      expect(window.location.hash).toMatch(/^#\/demos\?recording=r-portal-tour-/),
    );
    expect(writes()).toMatchObject([
      {
        method: 'POST',
        path: '/operator/demos/portal-tour/recordings',
        reason: 'roligere kamera i filmen',
        body: {
          editOf: 'r-tour-1',
          instruction: 'Gjør zoomen på Statistikk roligere',
          costCapUsd: 1,
        },
      },
    ]);
  });

  it('makes no paid call until the cost of the edit is approved', async () => {
    const { writes } = await openStudio();
    const plan = await askDirector('Kortere pauser');
    fireEvent.change(within(plan).getByLabelText('Begrunnelse'), {
      target: { value: 'kortere pauser i filmen' },
    });

    fireEvent.click(within(plan).getByRole('button', { name: /^Lag utgave/ }));

    expect(writes()).toEqual([]);
  });

  it('shows an edit in progress by its instruction and the film it changes', async () => {
    const { api } = studio();
    const queued = await api.requestEdit(
      'portal-tour',
      'roligere kamera',
      'r-tour-1',
      'Kortere pauser',
      1,
    );
    render(<Demos api={api} params={new URLSearchParams(`recording=${queued.id}`)} />);

    expect(await screen.findByText('Kortere pauser')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se filmen som endres' }).getAttribute('href')).toBe(
      '#/demos?recording=r-tour-1',
    );
  });

  it('offers no new cut of a film recorded without an edit list', async () => {
    const { api } = studio();
    render(<Demos api={api} params={new URLSearchParams('recording=r-altinn-1')} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Regissør' }));

    expect(screen.getByText(/ingen klippeliste å endre/)).toBeTruthy();
    expect(screen.queryByLabelText('Be om et nytt klipp')).toBeNull();
  });

  it('shows what a film spent of its approved cost', async () => {
    await openStudio();

    expect(
      screen.getByText(
        (_, el) => el?.tagName === 'SPAN' && el.textContent === 'KI-kostnad 1,27 av høyst 4 USD',
      ),
    ).toBeTruthy();
  });
});

describe('scenes in the studio', () => {
  const scenesTrack = () =>
    within(screen.getByRole('list', { name: 'Scener' }))
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));

  it('shows each step scene by its template and a chapter card before each chapter', async () => {
    await openStudio('r-walk-2');

    const track = scenesTrack();
    expect(track.filter((l) => /Kapittelkort/.test(l ?? ''))).toHaveLength(4);
    expect(track).toContain('Scene 13, Tavle, Hvor langt vi har kommet, 1:12');
    fireEvent.click(screen.getByRole('button', { name: /^Scene 13,/ }));
    expect((screen.getByLabelText('Mal') as HTMLSelectElement).value).toBe('board');
  });

  it('starts a chapter on the timeline with its card', async () => {
    await openStudio('r-walk-2');

    const chapters = within(screen.getByRole('list', { name: 'Kapitler' }))
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    const cards = scenesTrack().filter((l) => /Kapittelkort/.test(l ?? ''));
    expect(chapters.slice(1).map((l) => l?.split(', ').at(-1))).toEqual(
      cards.slice(1).map((l) => l?.split(', ').at(-1)),
    );
  });

  it("saves a scene's template, fields and page with the script and a reason", async () => {
    const { writes } = await openStudio('r-walk-2');
    fireEvent.click(screen.getByRole('button', { name: /^Scene 4, Skjerm, Oversikt,/ }));

    fireEvent.change(screen.getByLabelText('Mal'), { target: { value: 'code' } });
    fireEvent.change(screen.getByLabelText('Eksempeldefinisjon', { exact: false }), {
      target: { value: 'kunnskapsassistenten' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Scene 6, Skjerm, Katalog,/ }));
    fireEvent.change(screen.getByLabelText('Side'), {
      target: { value: '/#/catalog' },
    });
    expect(screen.getByText('Endringer: 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lagre manus' }));
    await confirmWithReason('Lagre manus', 'kode i stedet for oversikten');

    await waitFor(() => expect(writes()).toHaveLength(1));
    const steps = writes()[0]?.body.steps as Record<string, unknown>[];
    expect(steps[1]?.scene).toEqual({
      template: 'code',
      title: 'Oversikt',
      definition: 'kunnskapsassistenten',
    });
    expect(steps[2]).toMatchObject({ page: '/#/catalog', scene: { template: 'screen' } });
    expect(steps[6]?.page).toBe('/#/services/new');
    expect(steps.filter((s) => s.chapter)).toHaveLength(4);
    expect(writes()[0]).toMatchObject({ reason: 'kode i stedet for oversikten', ifMatch: '3' });
    expect(writes()[0]?.body).toMatchObject({ exampleData: true, intro: expect.anything() });
  });

  it('refuses to save a page that would leave the app, or a template without what it needs', async () => {
    const { writes } = await openStudio('r-walk-2');
    fireEvent.click(screen.getByRole('button', { name: /^Replikk 3,/ }));

    fireEvent.change(screen.getByLabelText('Side'), {
      target: { value: '//evil.example' },
    });
    expect(screen.getByText('Skriv en sti i demoens app som starter med /.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Lagre manus' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Side'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Scene 4, Skjerm, Oversikt,/ }));
    fireEvent.change(screen.getByLabelText('Mal'), { target: { value: 'close' } });
    expect(screen.getByText('Fyll inn feltene malen trenger før du lagrer.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Lagre manus' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(writes()).toHaveLength(0);
  });
});

describe('voice and sound', () => {
  it('saves the chosen voice with its language and a reason', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('demo=portal-tour&sound=1')} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Engelsk' }));
    fireEvent.click(screen.getByRole('radio', { name: /^Sonia/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'engelsk stemme for nordisk publikum');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: 'PUT',
      path: '/operator/demos/portal-tour',
      reason: 'engelsk stemme for nordisk publikum',
      body: { voice: 'en-GB-SoniaNeural', language: 'en-GB' },
    });
  });

  it('saves a film without a voice and keeps its language', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('demo=portal-tour&sound=1')} />);

    fireEvent.click(await screen.findByRole('radio', { name: /^Uten stemme/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'bare teksting i denne filmen');

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toMatchObject({ voice: 'none', language: 'nb-NO' });
  });

  it('saves the music bed with a reason, and «Ingen» saves the film without music', async () => {
    const { api, writes } = studio();
    render(<Demos api={api} params={new URLSearchParams('demo=portal-tour&sound=1')} />);

    fireEvent.click(await screen.findByRole('radio', { name: /^Rolig puls/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'musikk under rundturen');
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body.music).toBe('pulse');
    cleanup();

    const walk = studio();
    render(<Demos api={walk.api} params={new URLSearchParams('demo=genki-walkthrough&sound=1')} />);
    fireEvent.click(await screen.findByRole('radio', { name: /^Ingen/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    await confirmWithReason('Lagre', 'bare tale i produktfilmen');
    await waitFor(() => expect(walk.writes()).toHaveLength(1));
    expect(walk.writes()[0]?.body).not.toHaveProperty('music');
  });

  it('shows the loudness the newest edition measured against the targets', async () => {
    const { api } = studio();
    render(<Demos api={api} params={new URLSearchParams('demo=genki-walkthrough&sound=1')} />);

    expect(await screen.findByText('Målt i utgave 2')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Tale målt −15,2 LUFS, mål −15' })).toBeTruthy();
  });
});
