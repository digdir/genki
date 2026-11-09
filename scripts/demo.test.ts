import { describe, expect, it } from 'vitest';
import { mixArgs, srtTime, ssml, subtitles } from './demo.ts';

describe('demo recordings', () => {
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
