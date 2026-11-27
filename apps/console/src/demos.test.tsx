// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient, type Demo, type DemoRecording } from './api';
import { cueStarts, Demos } from './screens/Demos';

document.getAnimations ??= () => [];
afterEach(cleanup);
beforeAll(() => {
  URL.createObjectURL = () => 'blob:demo';
  URL.revokeObjectURL = () => undefined;
});

const srt = '1\n00:00:00,000 --> 00:00:04,000\nFørst.\n\n2\n00:01:04,500 --> 00:01:08,000\nSå.\n';

const apiFor = (routes: Record<string, unknown>) =>
  createApiClient({
    baseUrl: '/api',
    token: () => 'ops',
    fetch: async (input) => {
      const url = new URL(String(input), 'http://localhost');
      const key = url.pathname.replace(/^\/api/, '');
      if (key.endsWith('/files/demo.mp4')) return new Response(new Uint8Array([1]));
      if (key.endsWith('/files/demo.srt')) return new Response(srt);
      const body = routes[key];
      return new Response(JSON.stringify(body ?? { title: 'Not found' }), {
        status: body === undefined ? 404 : 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

const recording = (over: Partial<DemoRecording> = {}): DemoRecording => ({
  id: 'r1',
  demo: 'playground',
  demoVersion: 1,
  genkiVersion: '0.43.0',
  status: 'recorded',
  steps: 2,
  narrated: true,
  voice: 'nb-NO-PernilleNeural',
  startedAt: '2026-11-14T09:00:00.000Z',
  finishedAt: '2026-11-14T09:02:00.000Z',
  seconds: 124,
  files: [
    { name: 'demo.mp4', size: 1, contentType: 'video/mp4' },
    { name: 'demo.srt', size: 1, contentType: 'application/x-subrip' },
  ],
  ...over,
});

const demo = (over: Partial<Demo> = {}): Demo => ({
  id: 'playground',
  version: 1,
  updatedAt: '2026-11-14T08:00:00.000Z',
  title: 'Prøv en tjeneste i prøveområdet',
  description: 'For kommuner som vurderer genki.',
  audience: ['municipality'],
  language: 'nb-NO',
  voice: 'nb-NO-PernilleNeural',
  app: 'portal',
  path: '/#/playground',
  steps: [{ say: 'Først velger vi hva vi vil prøve.' }, { say: 'Så stiller vi et spørsmål.' }],
  ...over,
});

const library = {
  genkiVersion: '0.43.0',
  data: [
    demo({ latest: recording(), recorded: recording() }),
    demo({
      id: 'run-log',
      title: 'Følg en kjøring i kjøringsloggen',
      latest: recording({ id: 'r2', genkiVersion: '0.41.3' }),
      recorded: recording({ id: 'r2', genkiVersion: '0.41.3' }),
    }),
    demo({
      id: 'test-set',
      title: 'Lag et testsett',
      app: 'console',
      audience: ['internal'],
      latest: recording({
        id: 'r3',
        status: 'failed',
        steps: 6,
        failure: { step: 4, message: 'timeout' },
      }),
      recorded: recording({ id: 'r4' }),
    }),
  ],
};

const cards = () => screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);

describe('the demo library', () => {
  it('marks a demo recorded on another genki version as out of date, and a failed one as failed', async () => {
    render(<Demos api={apiFor({ '/operator/demos': library })} />);

    await screen.findByText('1 demo er utdatert');
    const failed = screen.getByRole('link', { name: 'Lag et testsett' }).closest('li');
    expect(within(failed as HTMLElement).getByText('Feilet')).toBeTruthy();
    expect(within(failed as HTMLElement).getByText(/stoppet på steg 4 av 6/)).toBeTruthy();
  });

  it('lists a stored demo of an app genki no longer has under the app name it was saved with', async () => {
    const retired = demo({ id: 'old', title: 'En gammel demo', app: 'workspace' as Demo['app'] });
    render(
      <Demos api={apiFor({ '/operator/demos': { genkiVersion: '0.43.0', data: [retired] } })} />,
    );

    const card = (await screen.findByRole('link', { name: 'En gammel demo' })).closest('li');
    expect(within(card as HTMLElement).getByText(/^workspace ·/)).toBeTruthy();
  });

  it('filters by state and area together', async () => {
    render(<Demos api={apiFor({ '/operator/demos': library })} />);
    await screen.findByText('1 demo er utdatert');

    fireEvent.change(screen.getByLabelText('Område'), { target: { value: 'portal' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Utdatert 1' }));

    expect(cards()).toEqual(['Følg en kjøring i kjøringsloggen']);
  });

  it('keeps the filters when the list is shown again', async () => {
    render(<Demos api={apiFor({ '/operator/demos': library })} />);
    await screen.findByText('1 demo er utdatert');
    fireEvent.change(screen.getByLabelText('Søk'), { target: { value: 'testsett' } });

    fireEvent.click(screen.getByRole('radio', { name: 'Feilet 1' }));

    expect((screen.getByLabelText('Søk') as HTMLInputElement).value).toBe('testsett');
    expect(cards()).toEqual(['Lag et testsett']);
  });
});

describe('a demo', () => {
  it('lists the narration with the time each step starts in the video', async () => {
    const detail = { ...demo(), genkiVersion: '0.43.0', recordings: [recording()] };
    render(<Demos api={apiFor({ '/operator/demos/playground': detail })} demo="playground" />);

    expect(
      await screen.findByRole('button', { name: 'Hopp til 1:05: Så stiller vi et spørsmål.' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Last ned mp4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undertekster (srt)' })).toBeTruthy();
  });

  it('shows the narration without times when the video was recorded from an older version of the demo', async () => {
    const detail = {
      ...demo({ version: 2 }),
      genkiVersion: '0.43.0',
      recordings: [recording({ demoVersion: 1 })],
    };
    render(<Demos api={apiFor({ '/operator/demos/playground': detail })} demo="playground" />);

    expect(await screen.findByLabelText('Video: Prøv en tjeneste i prøveområdet')).toBeTruthy();
    expect(screen.getByText('Så stiller vi et spørsmål.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Hopp til/ })).toBeNull();
  });

  it('plays the last good recording and says the latest one failed', async () => {
    const detail = {
      ...demo(),
      genkiVersion: '0.43.0',
      recordings: [
        recording({ id: 'r3', status: 'failed', failure: { step: 2, message: 'timeout' } }),
        recording(),
      ],
    };
    render(<Demos api={apiFor({ '/operator/demos/playground': detail })} demo="playground" />);

    expect(await screen.findByText(/Siste opptak stoppet på steg 2 av 2/)).toBeTruthy();
    expect(await screen.findByLabelText('Video: Prøv en tjeneste i prøveområdet')).toBeTruthy();
  });

  it('says so when the demo does not exist', async () => {
    render(<Demos api={apiFor({})} demo="borte" />);

    expect(await screen.findByText('Fant ikke demoen')).toBeTruthy();
  });
});

describe('subtitle cues', () => {
  it('reads the start of each cue in seconds', () => {
    expect(cueStarts(srt)).toEqual([0, 64.5]);
  });
});
