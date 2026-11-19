import type { Demo, DemoRecording, DemoSettingsView, DemoSpec } from '../../api';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

const problem = (status: number, type: string, message: string, path = '') =>
  json({ type, title: message, status, errors: [{ path, message }] }, status);

const screenshot = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#eef2f6"/><rect x="0" y="0" width="1280" height="56" fill="#1e2b3c"/><rect x="40" y="96" width="420" height="32" rx="6" fill="#c7d2de"/><rect x="40" y="160" width="1200" height="400" rx="12" fill="#ffffff" stroke="#c7d2de"/><text x="640" y="380" font-family="sans-serif" font-size="32" text-anchor="middle" fill="#1e2b3c">${label}</text></svg>`;

const steps = (lines: string[]): DemoSpec['steps'] =>
  lines.map((say, i) => ({
    say,
    ...(i > 0
      ? {
          do: [
            ['find', 'role', 'link', 'click', '--name', say.split(' ')[0] ?? 'Neste'],
            ['wait', '--text', 'Klar', '--timeout', '30000'],
          ],
        }
      : {}),
  }));

const base = (id: string, spec: Partial<DemoSpec>, version = 1): Demo => ({
  id,
  version,
  updatedBy: 'operator:Lise Dahl',
  updatedAt: '2026-11-10T09:00:00.000Z',
  title: '',
  description: '',
  audience: [],
  language: 'nb-NO',
  voice: 'nb-NO-PernilleNeural',
  viewport: [1280, 720],
  app: 'portal',
  path: '/',
  steps: [],
  ...spec,
});

const media = (names: string[]) =>
  names.map((name) => ({
    name,
    size: 1,
    contentType: name.endsWith('.mp4')
      ? 'video/mp4'
      : name.endsWith('.srt')
        ? 'application/x-subrip'
        : name.endsWith('.mp3')
          ? 'audio/mpeg'
          : 'image/png',
  }));

const recording = (id: string, demo: Demo, over: Partial<DemoRecording>): DemoRecording => {
  const made: DemoRecording = {
    id,
    demo: demo.id,
    demoVersion: demo.version,
    genkiVersion: '0.44.0',
    status: 'recorded',
    steps: demo.steps.length,
    narrated: true,
    voice: demo.voice,
    startedAt: '2026-11-17T08:00:00.000Z',
    finishedAt: '2026-11-17T08:02:00.000Z',
    files: media(['demo.mp4', 'demo.srt', 'sample.mp3']),
    ...over,
  };
  return made;
};

export const exampleDemoData = () => {
  const tour = base('portal-tour', {
    title: 'Rundtur i portalen',
    description: 'De viktigste sidene i portalen på under ett minutt.',
    audience: ['internal'],
    path: '/#/',
    ready: 'Oversikt',
    steps: steps([
      'Portalen er der en virksomhet lager og følger tjenestene sine.',
      'Tjenester viser alt virksomheten har laget.',
      'Datasett er kunnskapen tjenestene svarer fra.',
      'Logg viser hvem som endret hva, og hvorfor.',
    ]),
  });
  const altinn = base('altinn-login', {
    title: 'Sett opp en tjeneste med Altinn-innlogging',
    description: 'For kommuner: fra mal til en tjeneste som bare egne ansatte når.',
    audience: ['municipality'],
    path: '/#/services',
    signedIn: true,
    ready: 'Tjenester',
    steps: steps([
      'Vi starter i Tjenester og velger Ny tjeneste.',
      'Malen Byggesak-veileder gir et godt utgangspunkt.',
      'Under Tilgang slår vi på innlogging med Altinn.',
      'Bare ansatte med rollen saksbehandler får bruke tjenesten.',
      'Vi prøver tjenesten før den publiseres.',
    ]),
  });
  const tracing = base('tracing', {
    title: 'Følg en kjøring i sporingen',
    description: 'Fra et spørsmål til hvert steg modellen tok.',
    audience: ['internal'],
    app: 'console',
    path: '/#/tracing',
    ready: 'Sporing',
    steps: steps([
      'Sporingen viser hver kjøring på plattformen.',
      'Vi filtrerer på tjenesten Klarspråk for saksbehandlere.',
      'Listen viser de siste kjøringene med tid og kostnad.',
      'Åpne kjøringen for å se stegene.',
      'Hvert steg viser hva modellen fikk og svarte.',
    ]),
  });
  const plain = base('klarsprak', {
    title: 'Klarspråk for saksbehandlere',
    description: 'Skriv om et vedtak til klart språk.',
    audience: ['state-agency', 'municipality'],
    path: '/#/playground',
    signedIn: true,
    ready: 'Endre oppsett',
    steps: steps([
      'Prøveområdet lar oss teste en tjeneste før den tas i bruk.',
      'Vi limer inn et vedtak med tung tekst.',
      'Tjenesten skriver det om etter Språkrådets råd.',
    ]),
  });
  const failed = recording('r-tracing-2', tracing, {
    status: 'failed',
    startedAt: '2026-11-17T07:00:00.000Z',
    finishedAt: '2026-11-17T07:01:00.000Z',
    files: media(['step-1.png', 'step-2.png', 'step-3.png', 'failed-step-4.png']),
    failure: {
      step: 4,
      command: '["find","role","link","click","--name","Åpne kjøringen"]',
      message: 'Element not found: role link with name «Åpne kjøringen»',
    },
  });
  delete failed.seconds;
  const running = recording('r-klarsprak-1', plain, {
    status: 'running',
    startedAt: '2026-11-18T09:00:00.000Z',
    requestedBy: 'operator:Lise Dahl',
    files: media(['step-1.png']),
  });
  delete running.seconds;
  delete running.finishedAt;
  const recordings: DemoRecording[] = [
    recording('r-tour-1', tour, { seconds: 39, finishedAt: '2026-11-17T08:01:00.000Z' }),
    recording('r-altinn-1', altinn, {
      genkiVersion: '0.41.3',
      seconds: 130,
      startedAt: '2026-11-02T10:00:00.000Z',
      finishedAt: '2026-11-02T10:03:00.000Z',
    }),
    recording('r-tracing-1', tracing, {
      seconds: 85,
      startedAt: '2026-11-10T07:00:00.000Z',
      finishedAt: '2026-11-10T07:02:00.000Z',
    }),
    failed,
    running,
  ];
  return { demos: [tour, altinn, tracing, plain], recordings };
};

const defaultSettings: DemoSettingsView = {
  voice: 'nb-NO-PernilleNeural',
  viewport: [1280, 720],
  tenant: '310000001',
  login: 'Demo-opptaker, testbruker i Eksempel kommune',
  retentionDays: 90,
  writerDailyTokens: 100_000,
  version: 1,
  updatedBy: 'operator:Lise Dahl',
  updatedAt: '2026-11-12T09:00:00.000Z',
  recorder: 'job',
  sample: { recording: 'r-tour-1', file: 'sample.mp3' },
};

const isOpen = (r: DemoRecording) => r.status === 'queued' || r.status === 'running';

export const demosMock = (
  data = exampleDemoData(),
  actor = 'operator:Lise Dahl',
  now = () => new Date(),
  recorder: DemoSettingsView['recorder'] = 'job',
) => {
  let demos = data.demos;
  let recordings = data.recordings;
  let settings = { ...structuredClone(defaultSettings), recorder };
  const genkiVersion = '0.44.0';
  const newestFirst = (a: DemoRecording, b: DemoRecording) =>
    b.startedAt.localeCompare(a.startedAt);
  const own = (id: string) => recordings.filter((r) => r.demo === id).sort(newestFirst);
  const replace = (next: DemoRecording) =>
    (recordings = recordings.map((r) => (r.id === next.id ? next : r)));
  const advance = (r: DemoRecording) => {
    if (r.status === 'queued') return replace({ ...r, status: 'running' });
    if (r.status !== 'running') return;
    const done = r.files.filter((f) => /^step-\d+\.png$/.test(f.name)).length;
    if (done < r.steps)
      return replace({ ...r, files: [...r.files, ...media([`step-${done + 1}.png`])] });
    replace({
      ...r,
      status: 'recorded',
      finishedAt: now().toISOString(),
      seconds: r.steps * 9,
      files: [...r.files, ...media(r.upTo ? ['demo.mp4'] : ['demo.mp4', 'demo.srt'])],
    });
  };
  const inLibrary = (demo: Demo): Demo => {
    const list = own(demo.id);
    const full = list.filter((r) => r.upTo === undefined && r.status !== 'cancelled');
    const latest = full.find((r) => !isOpen(r));
    const recorded = full.find((r) => r.status === 'recorded');
    const open = list.find(isOpen);
    return {
      ...demo,
      ...(latest ? { latest } : {}),
      ...(recorded ? { recorded } : {}),
      ...(open ? { open } : {}),
    };
  };

  return async (
    path: string,
    method: string,
    reason: string | null,
    body: () => Record<string, unknown>,
  ): Promise<Response | undefined> => {
    const needReason = () =>
      problem(400, 'about:blank', 'Skriv en begrunnelse på minst ti tegn.', 'change-reason');
    if (method === 'GET' && path === '/operator/demos')
      return json({
        genkiVersion,
        recorder: settings.recorder,
        data: demos.map(inLibrary).sort((a, b) => a.title.localeCompare(b.title, 'nb')),
      });
    const demoPath = /^\/operator\/demos\/([^/]+)$/.exec(path);
    if (demoPath) {
      const id = decodeURIComponent(demoPath[1] ?? '');
      const found = demos.find((d) => d.id === id);
      if (method === 'GET')
        return found
          ? json({
              ...found,
              genkiVersion,
              recorder: settings.recorder,
              recordings: own(id),
            })
          : problem(404, 'about:blank', 'Not found');
      if (method === 'PUT') {
        if (!reason) return needReason();
        const spec = body() as unknown as DemoSpec;
        if (!spec.title || !Array.isArray(spec.steps) || spec.steps.length === 0)
          return problem(400, 'about:blank', 'steps must list at least one step', 'steps');
        const next = {
          ...base(id, spec, (found?.version ?? 0) + 1),
          updatedBy: actor,
          updatedAt: now().toISOString(),
        };
        demos = found ? demos.map((d) => (d.id === id ? next : d)) : [...demos, next];
        return json(next, found ? 200 : 201);
      }
    }
    const request = /^\/operator\/demos\/([^/]+)\/recordings$/.exec(path);
    if (request && method === 'POST') {
      if (!reason) return needReason();
      const demo = demos.find((d) => d.id === decodeURIComponent(request[1] ?? ''));
      if (!demo) return problem(404, 'about:blank', 'Not found');
      if (settings.recorder !== 'job')
        return problem(503, 'urn:genai:problem:recorder-not-set-up', 'no recorder job');
      if (own(demo.id).some(isOpen))
        return problem(409, 'urn:genai:problem:recording-open', 'not finished', 'recording');
      const upTo = typeof body().upTo === 'number' ? (body().upTo as number) : undefined;
      const queued: DemoRecording = {
        id: `r-${demo.id}-${recordings.length + 1}`,
        demo: demo.id,
        demoVersion: demo.version,
        genkiVersion,
        status: 'queued',
        steps: upTo ?? demo.steps.length,
        narrated: upTo === undefined,
        ...(upTo === undefined ? { voice: demo.voice } : { upTo }),
        startedAt: now().toISOString(),
        files: [],
        requestedBy: actor,
      };
      recordings = [...recordings, queued];
      return json(queued, 202);
    }
    const one = /^\/operator\/recordings\/([^/]+)$/.exec(path);
    if (one && method === 'GET') {
      const found = recordings.find((r) => r.id === decodeURIComponent(one[1] ?? ''));
      if (!found) return problem(404, 'about:blank', 'Not found');
      if (found.id !== 'r-klarsprak-1') advance(found);
      return json(recordings.find((r) => r.id === found.id));
    }
    const cancel = /^\/operator\/recordings\/([^/]+)\/cancel$/.exec(path);
    if (cancel && method === 'POST') {
      if (!reason) return needReason();
      const found = recordings.find((r) => r.id === decodeURIComponent(cancel[1] ?? ''));
      if (!found) return problem(404, 'about:blank', 'Not found');
      if (!isOpen(found))
        return problem(409, 'urn:genai:problem:recording-finished', 'finished', 'status');
      const next: DemoRecording = {
        ...found,
        status: 'cancelled',
        finishedAt: now().toISOString(),
        cancelledBy: actor,
      };
      replace(next);
      return json(next);
    }
    const file = /^\/operator\/recordings\/([^/]+)\/files\/([^/]+)$/.exec(path);
    if (file && method === 'GET') {
      const name = decodeURIComponent(file[2] ?? '');
      if (name.endsWith('.png'))
        return new Response(screenshot(name.replace('.png', '')), {
          headers: { 'content-type': 'image/svg+xml' },
        });
      if (name.endsWith('.srt'))
        return new Response('1\n00:00:00,000 --> 00:00:04,000\nFørst.\n', {
          headers: { 'content-type': 'application/x-subrip' },
        });
      return new Response(new Uint8Array([0]), {
        headers: { 'content-type': name.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4' },
      });
    }
    if (path === '/operator/demo-settings') {
      if (method === 'GET') return json(settings);
      if (method === 'PUT') {
        if (!reason) return needReason();
        settings = {
          ...settings,
          ...(body() as Partial<DemoSettingsView>),
          version: settings.version + 1,
          updatedBy: actor,
          updatedAt: now().toISOString(),
        };
        return json(settings);
      }
    }
    return undefined;
  };
};
