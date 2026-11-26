import { describe, expect, it } from 'vitest';
import {
  alignWords,
  estimatedWords,
  fastTranscriptionUrl,
  heardWords,
  parseCaptureLog,
  sentencesOf,
} from './demo-events.ts';

const heard = (pairs: [string, number, number][]) =>
  pairs.map(([text, at, length]) => ({
    text,
    offsetMilliseconds: at,
    durationMilliseconds: length,
  }));

describe('word timings', () => {
  it('times every written word by the word it was heard as', () => {
    const words = alignWords(
      'Her er Kunnskapsassistenten.',
      heard([
        ['Her', 100, 200],
        ['er', 300, 100],
        ['kunnskapsassistentene.', 400, 1200],
      ]),
      2,
    );
    expect(words).toEqual([
      { text: 'Her', at: 0.1, seconds: 0.2 },
      { text: 'er', at: 0.3, seconds: 0.1 },
      { text: 'Kunnskapsassistenten.', at: 0.4, seconds: 1.2 },
    ]);
  });

  it('spreads written words that were not heard between their heard neighbours', () => {
    const words = alignWords(
      'en to tre fire',
      heard([
        ['en', 0, 200],
        ['fire', 1000, 200],
      ]),
      1.2,
    );
    expect(words.map((w) => w.at)).toEqual([0, 0.2, 0.6, 1]);
  });

  it('estimates timings from the length of the words when nothing was heard', () => {
    const words = estimatedWords('a bbbb', 2);
    expect(words[0]?.at).toBe(0);
    expect((words[1]?.at ?? 0) + (words[1]?.seconds ?? 0)).toBeCloseTo(2);
    expect(alignWords('a bbbb', [], 2)).toEqual(words);
  });

  it('reads the words out of a fast transcription answer', () => {
    expect(heardWords({ phrases: [{ words: heard([['Hei', 0, 100]]) }] })).toHaveLength(1);
    expect(heardWords({})).toEqual([]);
  });

  it('splits a line into sentences at their full stops', () => {
    expect(sentencesOf(estimatedWords('Én. To tre? Fire', 3)).map((s) => s.length)).toEqual([
      1, 2, 1,
    ]);
  });

  it('sends audio for word timings only to an https Azure AI endpoint', () => {
    expect(fastTranscriptionUrl('https://genki-test-ai.cognitiveservices.azure.com/')).toBe(
      'https://genki-test-ai.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15',
    );
    expect(() => fastTranscriptionUrl('https://evil.example.com')).toThrow();
    expect(() =>
      fastTranscriptionUrl('http://genki-test-ai.cognitiveservices.azure.com'),
    ).toThrow();
  });
});

describe('event log', () => {
  const log = {
    viewport: [1920, 1080],
    scale: 1.5,
    seconds: 10,
    language: 'nb-NO',
    steps: [
      {
        say: 'Her er tjenestene.',
        start: 0,
        cue: 0.5,
        end: 4,
        voice: { file: '77789712ea682d2a.mp3', seconds: 3 },
        words: estimatedWords('Her er tjenestene.', 3),
        landmarks: [],
        moves: [],
        clicks: [{ at: 1, x: 10, y: 20 }],
        scrolls: [],
      },
    ],
  };
  const withVoice = (file: string) => ({
    ...log,
    steps: [{ ...log.steps[0], voice: { file, seconds: 3 } }],
  });

  it('reads an event log the recorder wrote', () => {
    expect(parseCaptureLog(log).steps[0]?.voice.file).toBe('77789712ea682d2a.mp3');
  });

  it('refuses an event log with fields it does not know or a voice file outside the voice folder', () => {
    expect(() => parseCaptureLog({ ...log, extra: 1 })).toThrow();
    expect(() => parseCaptureLog(withVoice('../../etc/passwd'))).toThrow();
    expect(() => parseCaptureLog(withVoice('/tmp/a.mp3'))).toThrow();
    expect(() => parseCaptureLog(withVoice('-i.mp3 x'))).toThrow();
  });
});
