import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  closeSync,
  fstatSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  apiKeyScript,
  browserLaunch,
  cached,
  Cancelled,
  demoOfRecording,
  demoSignIn,
  downloadEditSource,
  failureOf,
  libraryOf,
  managedIdentityTokenUrl,
  estimateDemo,
  keep,
  darkScript,
  languageScript,
  parseArgs,
  parseDemo,
  pickDemos,
  queuedOf,
  spendFromEnv,
  spentFile,
  voiceSpentOf,
  recordDemo,
  sampleLineOf,
  RecordingOpen,
  posterArgs,
  readyFailure,
  retrying,
  runStep,
  scriptLiteral,
  signInBrowser,
  srtTime,
  ssml,
  StepFailure,
  subtitles,
} from './demo.ts';
import { spendOf } from './demo-voice.ts';

const demosDir = join(import.meta.dirname, '../demos');
const minimal = (steps: string) =>
  `title: T\nlanguage: nb-NO\nvoice: nb-NO-PernilleNeural\nstart: https://portal.genki-test.digdir.cloud\nsteps:\n${steps}`;
const clock = () => {
  let t = 0;
  return { now: () => t, pause: (ms: number) => void (t += ms) };
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('demo recordings', () => {
  it('reuses a saved voice clip and leaves no partial file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-'));
    const file = join(dir, 'line.mp3');
    expect(cached(file)).toBe(false);
    keep(file, Buffer.from('clip'));
    expect(cached(file)).toBe(true);
    expect(readdirSync(dir)).toEqual(['line.mp3']);
  });

  it('asks for the voice again when a saved clip is empty, and replaces it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'demo-')), 'line.mp3');
    writeFileSync(file, '');
    expect(cached(file)).toBe(false);
    keep(file, Buffer.from('clip'));
    expect(readFileSync(file, 'utf8')).toBe('clip');
  });

  it('tells the browser the demo language and its base language', () => {
    expect(languageScript('nb-NO')).toBe(
      'Object.defineProperty(navigator,\'languages\',{get:()=>["nb-NO","nb"]});Object.defineProperty(navigator,\'language\',{get:()=>"nb-NO"});',
    );
  });

  it('keeps every page in the dark colour scheme so the film has one look', () => {
    const scheme = new Map([['data-color-scheme', 'light']]);
    const watchers: (() => void)[] = [];
    const root = {
      getAttribute: (name: string) => scheme.get(name) ?? null,
      setAttribute: (name: string, value: string) => scheme.set(name, value),
    };
    class Observer {
      constructor(callback: () => void) {
        watchers.push(callback);
      }
      observe() {}
    }
    runInNewContext(darkScript, {
      document: { documentElement: root },
      MutationObserver: Observer,
    });
    expect(scheme.get('data-color-scheme')).toBe('dark');
    scheme.set('data-color-scheme', 'light');
    for (const watch of watchers) watch();
    expect(scheme.get('data-color-scheme')).toBe('dark');
  });

  it('refuses a language that is not a language tag, so it cannot become browser code', () => {
    expect(() => languageScript("nb'});alert(1);//")).toThrow(/language must be a tag/);
    expect(() => languageScript('nb-NO\n')).toThrow(/language must be a tag/);
  });

  it('writes subtitle times as hours, minutes, seconds and milliseconds', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(3723.456)).toBe('01:02:03,456');
  });

  it('numbers each subtitle and ends it when its narration ends', () => {
    expect(
      subtitles([
        { at: 1.5, seconds: 2, text: 'Hei' },
        { at: 4, seconds: 1.25, text: 'Ha det' },
      ]),
    ).toBe('1\n00:00:01,500 --> 00:00:03,500\nHei\n\n2\n00:00:04,000 --> 00:00:05,250\nHa det\n');
  });

  it('escapes narration so it cannot break out of the speech markup', () => {
    expect(ssml('A & B <voice name="x">', 'nb-NO-PernilleNeural', 'nb-NO')).toBe(
      '<speak version="1.0" xml:lang="nb-NO"><voice name="nb-NO-PernilleNeural">A &amp; B &lt;voice name=&quot;x&quot;&gt;</voice></speak>',
    );
  });

  it('every demo in demos/ is valid and lasts about one to two minutes', () => {
    const files = pickDemos(demosDir).filter((f) => !f.endsWith('portal-tour.yaml'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const demo = parseDemo(readFileSync(file, 'utf8'), file);
      const seconds = estimateDemo(demo);
      expect({ file, long: seconds >= 50 && seconds <= 130 }).toEqual({ file, long: true });
      expect({ file, dashes: /\u2014/.test(readFileSync(file, 'utf8')) }).toEqual({
        file,
        dashes: false,
      });
    }
  });

  it('names every problem in a demo file at once', () => {
    expect(() =>
      parseDemo(
        'title: ""\nlanguage: norsk\nvoice: "a b"\nstart: http://x\nhlod: 1\nsteps:\n  - say: ""\n    hold: 30\n',
      ),
    ).toThrow(
      /unknown field hlod[\s\S]*title is missing[\s\S]*language must be[\s\S]*voice must be[\s\S]*start must be an https or localhost URL[\s\S]*step 1: say is missing[\s\S]*step 1: hold must be/,
    );
  });

  it('refuses browser commands that could read the session or run code', () => {
    for (const command of ['eval, "1"', 'storage, session', 'cookies', 'screenshot, x.png'])
      expect(() => parseDemo(minimal(`  - say: Hei\n    do:\n      - [${command}]\n`))).toThrow(
        /is not one of/,
      );
  });

  it('refuses a flag in a command outside the flags the demos use', () => {
    expect(() => parseDemo(minimal('  - say: Hei\n    do:\n      - [wait, --fn, "1"]\n'))).toThrow(
      /takes only the flags/,
    );
  });

  it('runs no stored command with a flag outside the list, before touching the browser', () => {
    const calls: string[][] = [];
    const step = { say: 'Hei', do: [['find', 'role', 'link', 'click', '--args', '--no-sandbox']] };

    expect(() => runStep(step, 0, (...args) => calls.push(args))).toThrow(StepFailure);
    expect(calls).toEqual([]);
  });

  it('accepts numbers in a command and passes them on as text', () => {
    const demo = parseDemo(minimal('  - say: Hei\n    do:\n      - [wait, 500]\n'));
    expect(demo.steps[0]?.do).toEqual([['wait', '500']]);
  });

  it('keeps trying a click until the element appears', () => {
    const { now, pause } = clock();
    let calls = 0;
    const browser = () => {
      if (++calls < 3) throw new Error('No element found');
    };
    runStep(
      { say: 'Hei', do: [['find', 'role', 'link', 'click']] },
      0,
      browser,
      15_000,
      now,
      pause,
    );
    expect(calls).toBe(3);
  });

  it('fails loudly with the step, its narration and the command when an element never appears', () => {
    const { now, pause } = clock();
    const browser = () => {
      throw Object.assign(new Error('Command failed'), {
        stderr: 'No element found: Tjenester\nmore',
      });
    };
    expect(() =>
      runStep(
        { say: 'Åpne tjenestene', do: [['find', 'role', 'link', 'click', '--name', 'Tjenester']] },
        2,
        browser,
        15_000,
        now,
        pause,
      ),
    ).toThrow(
      'Step 3 («Åpne tjenestene») failed on: find role link click --name Tjenester\n  No element found: Tjenester',
    );
    expect(now()).toBeGreaterThanOrEqual(15_000);
  });

  it('names the failed step by number, so its screenshot can be found', () => {
    const { now, pause } = clock();
    const failure = (() => {
      try {
        runStep(
          { say: 'Hei', do: [['find', 'role', 'link', 'click']] },
          4,
          () => {
            throw new Error('No element found');
          },
          1_000,
          now,
          pause,
        );
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(StepFailure);
    expect((failure as StepFailure).step).toBe(5);
  });

  it('reports a start page that never shows its ready text as step 0', () => {
    const demo = parseDemo(
      minimal('  - say: Hei\n').replace('steps:', 'ready: Prøveområde\nsteps:'),
    );
    const failure = readyFailure(
      demo,
      Object.assign(new Error('x'), { stderr: 'Timeout 30000ms' }),
    );
    expect(failure.step).toBe(0);
    expect(failure.message).toBe(
      'The start page https://portal.genki-test.digdir.cloud never showed «Prøveområde»\n  Timeout 30000ms',
    );
  });

  it('glides the pointer before each command and starts the voice once the page it opens has loaded', () => {
    const calls: string[] = [];
    runStep(
      {
        say: 'Hei',
        do: [
          ['find', 'role', 'link', 'click', '--name', 'Logg'],
          ['wait', '--text', 'Logg'],
          ['find', 'role', 'tab', 'hover', '--name', 'Endringer'],
        ],
      },
      0,
      (...command) => calls.push(command[0] === 'find' ? (command[3] ?? '') : (command[0] ?? '')),
      15_000,
      undefined,
      undefined,
      { point: (command) => calls.push(`point ${command[0]}`), cue: () => calls.push('voice') },
    );
    expect(calls).toEqual([
      'point find',
      'click',
      'point wait',
      'wait',
      'voice',
      'point find',
      'hover',
    ]);
  });

  it('starts the voice at once in a step that only points', () => {
    const calls: string[] = [];
    runStep(
      { say: 'Hei', do: [['find', 'text', 'Kvote', 'hover']] },
      0,
      () => calls.push('hover'),
      15_000,
      undefined,
      undefined,
      { cue: () => calls.push('voice') },
    );
    expect(calls).toEqual(['voice', 'hover']);
  });

  it('refuses a step with a command that is not allowed before pointing or speaking', () => {
    const calls: string[] = [];
    expect(() =>
      runStep(
        {
          say: 'Hei',
          do: [
            ['hover', '#a'],
            ['eval', 'x'],
          ],
        },
        0,
        () => calls.push('browser'),
        15_000,
        undefined,
        undefined,
        { point: () => calls.push('point'), cue: () => calls.push('voice') },
      ),
    ).toThrow(/not allowed/);
    expect(calls).toEqual([]);
  });

  it('marks the moment a step leaves the page, after the pointer arrives and before the click', () => {
    const calls: string[] = [];
    runStep(
      {
        say: 'Hei',
        do: [
          ['find', 'text', 'Kvote', 'hover'],
          ['find', 'role', 'link', 'click', '--name', 'Logg'],
          ['wait', '--text', 'Logg'],
        ],
      },
      0,
      (...command) => calls.push(command[0] === 'find' ? (command[3] ?? '') : (command[0] ?? '')),
      15_000,
      undefined,
      undefined,
      {
        point: () => calls.push('point'),
        navigate: () => calls.push('leave'),
        cue: () => calls.push('voice'),
      },
    );
    expect(calls).toEqual(['point', 'hover', 'point', 'leave', 'click', 'point', 'wait', 'voice']);
  });

  it('reads a title card, a closing card, chapters and focus from a demo', () => {
    const demo = parseDemo(
      minimal('  - say: Hei\n    chapter: Hva er Genki\n    focus: [role, table]\n').replace(
        'steps:',
        "intro:\n  title: Genki\n  subtitle: Generativ KI\n  presenter: Ola, Digdir\noutro:\n  title: 'Først ut: Simen'\nsteps:",
      ),
    );
    expect(demo.intro).toEqual({
      title: 'Genki',
      subtitle: 'Generativ KI',
      presenter: 'Ola, Digdir',
    });
    expect(demo.outro).toEqual({ title: 'Først ut: Simen' });
    expect(demo.steps[0]).toMatchObject({ chapter: 'Hva er Genki', focus: ['role', 'table'] });
  });

  it('refuses a card without a title, a card with other fields and a focus it cannot find', () => {
    expect(() =>
      parseDemo(
        minimal('  - say: Hei\n    focus: [eval, x]\n').replace(
          'steps:',
          'intro:\n  subtitle: x\noutro:\n  title: T\n  logo: x.png\nsteps:',
        ),
      ),
    ).toThrow(
      /intro must have a title[\s\S]*outro takes only title, subtitle and presenter[\s\S]*step 1: focus must be/,
    );
  });

  it('does not repeat a navigation that failed', () => {
    let calls = 0;
    const browser = () => {
      calls++;
      throw new Error('net::ERR');
    };
    expect(() => runStep({ say: 'Hei', do: [['open', 'https://x']] }, 0, browser)).toThrow(
      /Step 1/,
    );
    expect(calls).toBe(1);
  });

  it('gives up retrying at the deadline', () => {
    const { now, pause } = clock();
    expect(() =>
      retrying(
        () => {
          throw new Error('nope');
        },
        2_000,
        now,
        pause,
      ),
    ).toThrow('nope');
    expect(now()).toBe(2_000);
  });

  const apps = {
    portal: 'https://portal.example/',
    console: 'https://console.example',
    workspace: 'https://workspace.example/#/',
    tenant: '312521172',
  };
  const now = Date.parse('2026-11-13T10:00:00Z');
  const appOrigins = [
    'https://portal.example',
    'https://workspace.example',
    'https://console.example',
  ];
  const hostile = [
    '"',
    "'",
    '`',
    '${alert(1)}',
    '</script><script>alert(1)</script>',
    '\\',
    '\\"',
    '\u2028',
    '\u2029',
    '"});alert(1);//',
  ];

  const fetchThrough = (script: string, page = 'https://portal.example/services') => {
    const sent: { url: string; authorization: string | null }[] = [];
    const window = {
      fetch: (input: string, init?: RequestInit) => {
        sent.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        });
        return Promise.resolve(new Response('{}'));
      },
    };
    new Function('window', 'location', script)(window, { href: page });
    return { fetch: window.fetch, sent };
  };

  it('sends the demo key only to the app origins’ /api/, never to the issuer or a third party', async () => {
    const { fetch, sent } = fetchThrough(apiKeyScript('k3y', apps));
    for (const url of [
      '/api/tenants/1/me',
      'https://console.example/api/operator/tenants',
      'https://workspace.example/api/v1/models',
      '/auth/me',
      '/apiary',
      'https://test.ansattporten.no/api/x',
      'https://portal.example.evil.no/api/x',
    ])
      await fetch(url, { headers: { accept: 'application/json' } });
    expect(sent.map((c) => c.authorization)).toEqual([
      'Bearer k3y',
      'Bearer k3y',
      'Bearer k3y',
      null,
      null,
      null,
      null,
    ]);
  });

  it('never puts the demo key in the arguments of an agent-browser command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-launch-'));
    const commands: string[][] = [
      browserLaunch('demo', dir, 'nb-NO', { key: 'k3y', apps }),
      ...demoSignIn(apps, now),
    ];
    signInBrowser(apps, now, (...args) => commands.push(args));
    expect(commands.flat().join(' ')).not.toContain('k3y');
    const keyFile = join(dir, 'api-key.js');
    expect(commands[0]).toContain(keyFile);
    const fd = openSync(keyFile, 'r');
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(readFileSync(fd, 'utf8')).toContain('k3y');
    } finally {
      closeSync(fd);
    }
  });

  it('launches with no key script when the demo is not signed in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-launch-'));
    expect(browserLaunch('demo', dir, 'nb-NO').join(' ')).not.toContain('api-key.js');
    expect(existsSync(join(dir, 'api-key.js'))).toBe(false);
  });

  it('routes every app origin’s /auth/me', () => {
    expect(demoSignIn(apps, now).map((c) => c.slice(0, 3))).toEqual(
      appOrigins.map((o) => ['network', 'route', `${o}/auth/me`]),
    );
  });

  it('answers /auth/me as signed in for the demo tenant', () => {
    const routes = demoSignIn(apps, now).filter((c) => c[0] === 'network');
    expect(routes.map((c) => c[3])).toEqual(['--body', '--body', '--body']);
    expect(JSON.parse(routes[0]?.[4] ?? '')).toEqual({
      name: 'Demo',
      organisation: '312521172',
      organisations: [{ orgNumber: '312521172', name: 'Demo' }],
      expiresAt: '2026-11-13T11:00:00.000Z',
    });
    expect(JSON.parse(routes[1]?.[4] ?? '').operator).toBeUndefined();
  });

  it('answers /auth/me on the console as signed in as an operator', () => {
    const route = demoSignIn(apps, now).find((c) => c[2] === 'https://console.example/auth/me');
    expect(JSON.parse(route?.[4] ?? '')).toMatchObject({
      organisation: '312521172',
      operator: true,
    });
  });

  it('keeps a hostile key and tenant as data in the sign-in commands and the key script', async () => {
    for (const value of hostile) {
      const commands = demoSignIn({ ...apps, tenant: value }, 0);
      expect(JSON.parse(commands[0]?.[4] ?? '').organisation).toBe(value);
      expect(() => apiKeyScript(value, apps)).toThrow('DEMO_API_KEY must be a bearer token');
    }
    const token = 'a.b_c~d+e/f=-';
    const { fetch, sent } = fetchThrough(apiKeyScript(token, apps));
    await fetch('/api/x');
    expect(sent[0]?.authorization).toBe(`Bearer ${token}`);
  });

  it.each(['network'])(
    'keeps the key out of the error when agent-browser fails on %s while signing in',
    (failing) => {
      const ab = (...args: string[]) => {
        if (args[0] === failing) throw new Error(`Command failed: agent-browser ${args.join(' ')}`);
      };
      let caught: unknown;
      try {
        signInBrowser(apps, now, ab);
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toBe(
        'Error: agent-browser could not sign in to https://portal.example',
      );
    },
  );

  it('embeds a hostile value in browser code only as one literal that reads back unchanged', () => {
    for (const value of hostile) {
      const literal = scriptLiteral(value);
      expect(literal).toMatch(/^"[^<>/\u2028\u2029]*"$/);
      expect(literal.slice(1, -1)).not.toMatch(/(^|[^\\])(\\\\)*"/);
      expect(JSON.parse(literal)).toBe(value);
    }
  });

  it('records one demo by name and refuses a name that is not a demo', () => {
    expect(pickDemos(demosDir, 'portal-tour')).toEqual([join(demosDir, 'portal-tour.yaml')]);
    expect(() => pickDemos(demosDir, '../package')).toThrow(/No demo called/);
    expect(() => pickDemos(demosDir, 'missing')).toThrow(/No demo called/);
  });

  it('reads the mode, the flags and the files from the command line', () => {
    expect(parseArgs(['demos/a.yaml'])).toEqual({
      mode: 'record',
      silent: false,
      queued: false,
      only: undefined,
      files: ['demos/a.yaml'],
    });
    expect(parseArgs(['record', '--silent', '--only', 'a'])).toEqual({
      mode: 'record',
      silent: true,
      queued: false,
      only: 'a',
      files: [],
    });
    expect(parseArgs(['record', '--only', ''])).toMatchObject({ only: undefined, files: [] });
    expect(parseArgs(['check'])).toMatchObject({ mode: 'check', files: [] });
    expect(parseArgs(['queued'])).toMatchObject({ mode: 'queued', files: [] });
    expect(parseArgs(['recording', '--queued'])).toMatchObject({
      mode: 'recording',
      queued: true,
      files: [],
    });
  });
});

describe('reporting to the demo library', () => {
  const fake = () => {
    const calls: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: unknown;
    }[] = [];
    let status = 200;
    const send = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        method: init?.method ?? 'GET',
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(init?.body === undefined ? {} : { body: init.body }),
      });
      if (url.endsWith('/health')) return Response.json({ version: '0.44.0' });
      if (url.endsWith('/recordings')) return Response.json({ id: 'r1' }, { status: 201 });
      return new Response('{}', { status });
    }) as typeof fetch;
    return { calls, send, fail: (s: number) => void (status = s) };
  };

  it('starts a recording on the version the API runs, with the recorder key', async () => {
    const { calls, send } = fake();
    const library = libraryOf('https://api.example/', 'nøkkel', send, () => Buffer.from('x'));

    const id = await library.start('playground', true, 'q1');

    expect(id).toBe('r1');
    const started = calls.find((c) => c.method === 'POST');
    expect(started?.url).toBe('https://api.example/recorder/demos/playground/recordings');
    expect(started?.headers['x-recorder-key']).toBe('nøkkel');
    expect(JSON.parse(String(started?.body))).toEqual({
      genkiVersion: '0.44.0',
      narrated: true,
      recording: 'q1',
    });
  });

  it('stops as cancelled when the API says the recording has ended', async () => {
    const { send, fail } = fake();
    const library = libraryOf('https://api.example', 'k', send, () => Buffer.from('x'));
    fail(409);

    await expect(library.upload('r1', 'step-1.png', 'f')).rejects.toBeInstanceOf(Cancelled);
  });

  it('tells an open recording of the demo apart from an ended one when starting', async () => {
    const send = (async (input: string | URL | Request) =>
      String(input).endsWith('/health')
        ? Response.json({ version: '0.44.0' })
        : Response.json(
            { type: 'urn:genai:problem:recording-open' },
            { status: 409 },
          )) as typeof fetch;
    const library = libraryOf('https://api.example', 'k', send, () => Buffer.from('x'));

    await expect(library.start('playground', true)).rejects.toBeInstanceOf(RecordingOpen);
  });

  it('skips a demo whose recording is already open and writes nothing for it', async () => {
    const name = `open-${Date.now()}`;
    const library = {
      start: () => Promise.reject(new RecordingOpen('open')),
      upload: () => Promise.reject(new Error('no upload expected')),
      finish: () => Promise.reject(new Error('no finish expected')),
    };

    const result = await recordDemo(parseDemo(minimal('  - say: Hei\n')), name, true, {
      library,
    });

    expect(result).toEqual({
      name,
      outcome: 'skipped',
      reason: 'another recording of it is open',
    });
    expect(existsSync(join('demos/out', name))).toBe(false);
  });

  it('records a model-voice demo without narration unless a cost cap is approved', async () => {
    vi.stubEnv('SPEECH_RESOURCE', 'speech');
    vi.stubEnv('SPEECH_RESOURCE_GROUP', 'rg');
    vi.stubEnv('SPEECH_SUBSCRIPTION', 'sub');
    vi.stubEnv('DEMO_AUDIO_ENDPOINT', 'https://x.openai.azure.com');
    const narrated: boolean[] = [];
    const library = {
      start: (_: string, voiced: boolean) => {
        narrated.push(voiced);
        return Promise.reject(new RecordingOpen('open'));
      },
      upload: () => Promise.reject(new Error('no upload expected')),
      finish: () => Promise.reject(new Error('no finish expected')),
    };
    const demo = parseDemo(
      minimal('  - say: Modellstemme\n').replace('voice: nb-NO-PernilleNeural', 'voice: cedar'),
    );

    await recordDemo(demo, `cedar-${Date.now()}`, false, { library }, spendOf());
    await recordDemo(demo, `cedar-${Date.now()}`, false, { library }, spendOf(5));

    expect(narrated).toEqual([false, true]);
  });

  it('reports a failed step with the command it was running and why', () => {
    const step = { say: 'Vi åpner kjøringen.', do: [['find', 'role', 'link', 'click']] };
    let caught: unknown;
    try {
      runStep(
        step,
        3,
        () => {
          throw new Error('no element\nmore');
        },
        0,
        clock().now,
        clock().pause,
      );
    } catch (error) {
      caught = error;
    }

    expect(failureOf(caught)).toEqual({
      step: 4,
      command: '["find","role","link","click"]',
      message: 'no element',
    });
  });

  it('builds the demo of a queued recording from its app, path and the first steps of a trial', () => {
    const demo = demoOfRecording(
      {
        id: 'r1',
        demo: 'playground',
        upTo: 1,
        demoSpec: {
          title: 'T',
          language: 'nb-NO',
          voice: 'nb-NO-PernilleNeural',
          app: 'console',
          path: '/#/demos',
          steps: [{ say: 'En.' }, { say: 'To.' }],
        },
        settings: { viewport: [1440, 900], tenant: null },
      },
      { DEMO_CONSOLE_URL: 'https://console.example/' },
    );

    expect(demo).toMatchObject({
      start: 'https://console.example/#/demos',
      viewport: [1440, 900],
      steps: [{ say: 'En.' }],
    });
  });

  it('lists the queued recordings with the recorder key and the lines each needs voiced, none for a trial', async () => {
    const full = '11111111-1111-4111-8111-111111111111';
    const trial = '22222222-2222-4222-8222-222222222222';
    const spec = {
      title: 'T',
      language: 'en-GB',
      voice: 'en-GB-SoniaNeural',
      app: 'portal',
      path: '/#/',
      steps: [{ say: 'One.' }, { say: 'Two.' }],
    };
    const keys: string[] = [];
    const send = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      keys.push((init?.headers as Record<string, string>)['x-recorder-key'] ?? '');
      if (url.endsWith('/recorder/recordings?status=queued'))
        return Response.json({
          data: [
            { id: full, demo: 'tour' },
            { id: trial, demo: 'try' },
            { id: '../demos', demo: 'x' },
          ],
        });
      const id = url.split('/').at(-1);
      return Response.json({
        id,
        demo: id === full ? 'tour' : 'try',
        ...(id === trial ? { upTo: 1 } : {}),
        demoSpec: spec,
        settings: { viewport: [1280, 720], tenant: null },
      });
    }) as typeof fetch;

    const queued = await queuedOf('https://api.example/', 'nøkkel', send);

    expect(queued).toEqual([
      {
        id: full,
        demo: 'tour',
        voice: 'en-GB-SoniaNeural',
        language: 'en-GB',
        lines: ['One.', 'Two.'],
      },
      { id: trial, demo: 'try', voice: 'en-GB-SoniaNeural', language: 'en-GB', lines: [] },
    ]);
    expect(keys).toEqual(['nøkkel', 'nøkkel', 'nøkkel']);
  });

  it('leaves out a queued recording that cannot be read or is no longer queued, and keeps the rest', async () => {
    const ok = '11111111-1111-4111-8111-111111111111';
    const gone = '22222222-2222-4222-8222-222222222222';
    const taken = '33333333-3333-4333-8333-333333333333';
    const send = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('status=queued'))
        return Response.json({ data: [{ id: gone }, { id: taken }, { id: ok }] });
      if (url.endsWith(gone)) return new Response('{}', { status: 404 });
      return Response.json({
        id: url.split('/').at(-1),
        demo: 'tour',
        status: url.endsWith(taken) ? 'running' : 'queued',
        demoSpec: {
          title: 'T',
          language: 'nb-NO',
          voice: 'nb-NO-FinnNeural',
          app: 'portal',
          path: '/',
          steps: [{ say: 'En.' }],
        },
        settings: { viewport: [1280, 720], tenant: null },
      });
    }) as typeof fetch;

    const queued = await queuedOf('https://api.example', 'k', send);

    expect(queued.map((q) => q.id)).toEqual([ok]);
  });

  it('finishes a queued recording that needs a sign-in key it does not have as failed, so it leaves the queue', async () => {
    const saved = process.env.DEMO_API_KEY;
    delete process.env.DEMO_API_KEY;
    const finished: unknown[] = [];
    const library = {
      start: (_name: string, narrated: boolean, recording?: string) =>
        Promise.resolve(narrated ? 'unexpected' : (recording ?? 'none')),
      upload: () => Promise.reject(new Error('no upload expected')),
      finish: (id: string, body: unknown) => Promise.resolve(void finished.push([id, body])),
    };
    try {
      const demo = parseDemo(minimal('  - say: Hei\n').replace('steps:', 'signedIn: true\nsteps:'));

      const result = await recordDemo(demo, 'signed', false, { library, recording: 'q1' });

      expect(result).toMatchObject({ outcome: 'failed' });
      expect(finished).toEqual([
        [
          'q1',
          { status: 'failed', failure: { step: 0, message: 'needs DEMO_API_KEY to sign in' } },
        ],
      ]);
    } finally {
      if (saved !== undefined) process.env.DEMO_API_KEY = saved;
    }
  });

  it('reads the voice sample in the language of the voice', () => {
    expect(sampleLineOf('en-GB')).toMatch(/^Hi!/);
    expect(sampleLineOf('nb-NO')).toMatch(/^Hei!/);
  });

  it('passes the approved cost cap on, and voices nothing for an edit, which reuses the clips of its film', async () => {
    const edit = '55555555-5555-4555-8555-555555555555';
    const cedar = '66666666-6666-4666-8666-666666666666';
    const spec = {
      title: 'T',
      language: 'nb-NO',
      voice: 'cedar',
      app: 'portal',
      path: '/#/',
      steps: [{ say: 'En.' }],
    };
    const send = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('?status=queued'))
        return Response.json({
          data: [
            { id: edit, demo: 'a' },
            { id: cedar, demo: 'b' },
          ],
        });
      const id = url.split('/').at(-1);
      return Response.json({
        id,
        demo: id === edit ? 'a' : 'b',
        costCapUsd: 3,
        ...(id === edit ? { editOf: cedar, instruction: 'Roligere' } : {}),
        demoSpec: spec,
        settings: { viewport: [1920, 1080], tenant: null },
      });
    }) as typeof fetch;

    const queued = await queuedOf('https://api.example', 'k', send);

    expect(queued.map((q) => [q.id, q.lines, q.costCapUsd])).toEqual([
      [edit, [], 3],
      [cedar, ['En.'], 3],
    ]);
  });

  it('reads what the voice job spent on a recording, and nothing from a missing or broken file', () => {
    const cache = mkdtempSync(join(tmpdir(), 'genki-spent-'));
    expect(voiceSpentOf(cache, 'a')).toBe(0);
    writeFileSync(spentFile(cache), JSON.stringify({ a: 0.42, b: -1, c: 'x' }));

    expect([voiceSpentOf(cache, 'a'), voiceSpentOf(cache, 'b'), voiceSpentOf(cache, 'c')]).toEqual([
      0.42, 0, 0,
    ]);
  });

  it('takes a local cost approval only from DEMO_COST_CAP_USD', () => {
    expect(spendFromEnv({})).toEqual({ spentUsd: 0 });
    expect(spendFromEnv({ DEMO_COST_CAP_USD: '4' })).toEqual({ capUsd: 4, spentUsd: 0 });
    expect(spendFromEnv({ DEMO_COST_CAP_USD: 'nei' })).toEqual({ spentUsd: 0 });
    expect(spendFromEnv({ DEMO_COST_CAP_USD: '0' })).toEqual({ spentUsd: 0 });
    expect(spendFromEnv({ DEMO_COST_CAP_USD: '-3' })).toEqual({ spentUsd: 0 });
  });

  it('stops when the queue answers with an error, so nothing is recorded from a half list', async () => {
    const send = (async () => new Response('{}', { status: 401 })) as typeof fetch;

    await expect(queuedOf('https://api.example', 'k', send)).rejects.toThrow(/answered 401/);
  });

  it('downloads the capture, events, edit list, stills and voice clips of the film it edits, the clips into the voice folder, and nothing else', async () => {
    const source = '44444444-4444-4444-8444-444444444444';
    const out = mkdtempSync(join(tmpdir(), 'genki-edit-'));
    const voices = mkdtempSync(join(tmpdir(), 'genki-voices-'));
    const asked: [string, string | null][] = [];
    const send = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      asked.push([url, new Headers(init?.headers).get('x-recorder-key')]);
      if (url.endsWith(source))
        return Response.json({
          id: source,
          files: [
            'capture.mp4',
            'events.json',
            'edl.json',
            'step-1.png',
            'voice-0123456789abcdef.mp3',
            'voice-0123456789abcdef.words.json',
            'voice-../x.mp3',
            'demo.mp4',
            '../x.png',
          ].map((name) => ({ name })),
        });
      return new Response(`bytes of ${decodeURIComponent(url.split('/').at(-1) ?? '')}`);
    }) as typeof fetch;

    const names = await downloadEditSource(
      'https://api.example/',
      'nøkkel',
      source,
      out,
      voices,
      send,
    );

    expect(names).toEqual([
      'capture.mp4',
      'events.json',
      'edl.json',
      'step-1.png',
      'voice-0123456789abcdef.mp3',
      'voice-0123456789abcdef.words.json',
    ]);
    expect(readdirSync(voices).sort()).toEqual([
      '0123456789abcdef.mp3',
      '0123456789abcdef.words.json',
    ]);
    expect(readdirSync(out).sort()).toEqual([
      'capture.mp4',
      'edl.json',
      'events.json',
      'step-1.png',
    ]);
    expect(readFileSync(join(out, 'edl.json'), 'utf8')).toBe('bytes of edl.json');
    expect(asked.map(([url]) => url)).toContain(
      `https://api.example/recorder/recordings/${source}/files/capture.mp4`,
    );
    expect(asked.every(([, key]) => key === 'nøkkel')).toBe(true);
  });

  it('refuses to edit a film whose capture, events or edit list is missing', async () => {
    const out = mkdtempSync(join(tmpdir(), 'genki-edit-'));
    const send = (async () =>
      Response.json({ files: [{ name: 'events.json' }, { name: 'edl.json' }] })) as typeof fetch;

    await expect(
      downloadEditSource('https://api.example', 'k', 's', out, out, send),
    ).rejects.toThrow(/no capture\.mp4/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('asks the managed identity for a speech token', () => {
    expect(managedIdentityTokenUrl('http://localhost:42356/msi/token')).toBe(
      'http://localhost:42356/msi/token?resource=https%3A%2F%2Fcognitiveservices.azure.com&api-version=2019-08-01',
    );
  });
});

describe('the still of a recording', () => {
  it('takes one frame two seconds in, scaled to the card', () => {
    expect(posterArgs('in.mp4', 'poster.jpg')).toEqual([
      '-y',
      '-loglevel',
      'error',
      '-ss',
      '2',
      '-i',
      'in.mp4',
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '4',
      'poster.jpg',
    ]);
  });
});
