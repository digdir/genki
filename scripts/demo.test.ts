import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cached, keep, languageScript, mixArgs, srtTime, ssml, subtitles } from './demo.ts';

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
      "Object.defineProperty(navigator,'languages',{get:()=>['nb-NO','nb']});Object.defineProperty(navigator,'language',{get:()=>'nb-NO'});",
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
});
