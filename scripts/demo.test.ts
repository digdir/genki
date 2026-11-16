import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cached,
  demoSessions,
  estimateDemo,
  keep,
  languageScript,
  mixArgs,
  parseArgs,
  parseDemo,
  pickDemos,
  retrying,
  runStep,
  scriptLiteral,
  sessionScript,
  srtTime,
  ssml,
  subtitles,
} from './demo.ts';

const demosDir = join(import.meta.dirname, '../demos');
const minimal = (steps: string) =>
  `title: T\nlanguage: nb-NO\nvoice: nb-NO-PernilleNeural\nstart: https://portal.genki-test.digdir.cloud\nsteps:\n${steps}`;
const clock = () => {
  let t = 0;
  return { now: () => t, pause: (ms: number) => void (t += ms) };
};

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

  it('starts each narration clip at the moment its step started', () => {
    const args = mixArgs(
      'raw.webm',
      [
        { file: 'a.mp3', at: 0 },
        { file: 'b.mp3', at: 6.456 },
      ],
      'x.srt',
      'out.mp4',
    );
    const filter = args.at(args.indexOf('-filter_complex') + 1);
    expect(filter).toBe(
      '[1:a]adelay=0:all=1[a0];[2:a]adelay=6456:all=1[a1];[a0][a1]amix=inputs=2:normalize=0[voice]',
    );
    expect(args).toContain('3:s');
  });

  it('records without a voice track when no line has narration', () => {
    const args = mixArgs('raw.webm', [], 'x.srt', 'out.mp4', 'nb-NO');
    expect(args).not.toContain('-filter_complex');
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v', '1:s', 'language=nob']));
  });

  it('marks the subtitles with the demo language', () => {
    expect(mixArgs('v', [], 's', 'o', 'en-GB')).toContain('language=eng');
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
    portalClientId: 'abc',
    tenant: '312521172',
  };
  const sessionPrefix = '(()=>{const s=';
  const sessionSuffix =
    '[location.origin];if(s&&!sessionStorage.getItem(s[0]))sessionStorage.setItem(s[0],s[1]);})();';
  const sessionData = (script: string) => {
    expect(script.startsWith(sessionPrefix)).toBe(true);
    expect(script.endsWith(sessionSuffix)).toBe(true);
    return JSON.parse(script.slice(sessionPrefix.length, -sessionSuffix.length)) as Record<
      string,
      [string, string]
    >;
  };
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

  it('puts the key only into the session of the portal or console origin it is on', () => {
    const sessions = demoSessions('k3y', apps, Date.parse('2026-11-13T10:00:00Z'));
    expect(Object.keys(sessions).sort()).toEqual([
      'https://console.example',
      'https://portal.example',
    ]);
    const [portalName, portalValue] = sessions['https://portal.example'] ?? [];
    expect(portalName).toBe('abc.session');
    const portal = JSON.parse(portalValue ?? '{}');
    expect(portal).toMatchObject({ token: 'k3y', organisations: [{ orgNumber: '312521172' }] });
    expect(portal.expiresAt).toBe(Date.parse('2026-11-13T11:00:00Z'));
    const [consoleName, consoleValue] = sessions['https://console.example'] ?? [];
    expect(consoleName).toBe('console.session');
    expect(JSON.parse(consoleValue ?? '{}').token).toBe('k3y');
    expect(sessionData(sessionScript(sessions))).toEqual(sessions);
  });

  it('embeds a hostile value in browser code only as one literal that reads back unchanged', () => {
    for (const value of hostile) {
      const literal = scriptLiteral(value);
      expect(literal).toMatch(/^"[^<>/\u2028\u2029]*"$/);
      expect(literal.slice(1, -1)).not.toMatch(/(^|[^\\])(\\\\)*"/);
      expect(JSON.parse(literal)).toBe(value);
    }
  });

  it('keeps a hostile key and tenant as data in the session script', () => {
    for (const value of hostile) {
      const sessions = demoSessions(value, { ...apps, tenant: value }, 0);
      const script = sessionScript(sessions);
      expect(script.slice(sessionPrefix.length, -sessionSuffix.length)).not.toMatch(
        /[<>\u2028\u2029]/,
      );
      const data = sessionData(script);
      expect(data).toEqual(sessions);
      const portal = JSON.parse(data['https://portal.example']?.[1] ?? '{}');
      expect(portal.token).toBe(value);
      expect(portal.organisations[0].orgNumber).toBe(value);
    }
  });

  it('refuses a portal client id that is not a plain name', () => {
    for (const value of [...hostile, '', 'a b', 'x'.repeat(129)])
      expect(() => demoSessions('k3y', { ...apps, portalClientId: value }, 0)).toThrow(
        /client id that is not a plain name/,
      );
    expect(() =>
      demoSessions('k3y', { ...apps, portalClientId: '0f3c-4e.portal_1' }, 0),
    ).not.toThrow();
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
      only: undefined,
      files: ['demos/a.yaml'],
    });
    expect(parseArgs(['record', '--silent', '--only', 'a'])).toEqual({
      mode: 'record',
      silent: true,
      only: 'a',
      files: [],
    });
    expect(parseArgs(['record', '--only', ''])).toMatchObject({ only: undefined, files: [] });
    expect(parseArgs(['check'])).toMatchObject({ mode: 'check', files: [] });
  });
});
