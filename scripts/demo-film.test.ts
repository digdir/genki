import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baselineEdl } from './demo-edl.ts';
import { estimatedWords, type CaptureLog } from './demo-events.ts';
import { aiFromEnv, editFilm, hearClip, keepVoices } from './demo-film.ts';
import { OverCap, spendOf } from './demo-voice.ts';

const clip = '0123456789abcdef.mp3';

const log = (files: (string | undefined)[]): CaptureLog => ({
  viewport: [1920, 1080],
  scale: 1.5,
  seconds: 10,
  language: 'nb-NO',
  steps: files.map((file, i) => ({
    say: 'Her er tjenestene.',
    start: i * 5,
    cue: i * 5,
    end: i * 5 + 5,
    voice: { ...(file ? { file } : {}), seconds: 3 },
    words: estimatedWords('Her er tjenestene.', 3),
    landmarks: [],
    moves: [],
    clicks: [],
    scrolls: [],
  })),
});

const token = () => Promise.resolve('token');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('making a film', () => {
  it('gives the director no model without an approved cap, with the director off, or without an endpoint', () => {
    const env = { DEMO_AUDIO_ENDPOINT: 'https://x.openai.azure.com' };

    expect(aiFromEnv(env, token, spendOf())).toBeUndefined();
    expect(aiFromEnv({ ...env, DEMO_DIRECTOR: 'off' }, token, spendOf(5))).toBeUndefined();
    expect(aiFromEnv({}, token, spendOf(5))).toBeUndefined();
    expect(aiFromEnv(env, token, spendOf(5, 1.5))).toMatchObject({
      deployment: 'gpt-5.5',
      budgetUsd: 3.5,
    });
  });

  it('counts every director call it is charged for in the film spend', () => {
    const spend = spendOf(5);
    aiFromEnv({ DEMO_AUDIO_ENDPOINT: 'https://x.openai.azure.com' }, token, spend)?.charge?.(0.4);

    expect(spend.spentUsd).toBeCloseTo(0.4);
  });

  it('keeps the voice clips the film was cut to with their word timings, and skips a clip that is missing or misnamed', () => {
    const voices = mkdtempSync(join(tmpdir(), 'genki-voices-'));
    const out = mkdtempSync(join(tmpdir(), 'genki-film-'));
    writeFileSync(join(voices, clip), 'mp3');
    writeFileSync(join(voices, '0123456789abcdef.words.json'), '[]');
    writeFileSync(join(voices, 'line.mp3'), 'mp3');

    const kept = keepVoices(
      log([clip, clip, 'line.mp3', 'fedcba9876543210.mp3', undefined]),
      out,
      voices,
    );

    expect(kept).toEqual(['voice-0123456789abcdef.mp3', 'voice-0123456789abcdef.words.json']);
    expect(readdirSync(out).sort()).toEqual(kept);
  });

  it('refuses an edit nobody approved a cost for before asking for a token', async () => {
    vi.stubEnv('DEMO_AUDIO_ENDPOINT', 'https://x.openai.azure.com');
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const out = mkdtempSync(join(tmpdir(), 'genki-edit-'));
    const capture = log([clip]);
    writeFileSync(join(out, 'events.json'), JSON.stringify(capture));
    writeFileSync(join(out, 'edl.json'), JSON.stringify(baselineEdl(capture)));

    await expect(editFilm(out, 'demo', out, 'Roligere', spendOf())).rejects.toThrow(OverCap);
    expect(send).not.toHaveBeenCalled();
  });

  it('hears a clip for word timings only with an approved cap that has room, and counts it', async () => {
    vi.stubEnv('DEMO_AUDIO_ENDPOINT', 'https://x.openai.azure.com');
    const send = vi.fn(async () => Response.json({ phrases: [] }));
    vi.stubGlobal('fetch', send);
    const voices = mkdtempSync(join(tmpdir(), 'genki-voices-'));
    writeFileSync(join(voices, clip), 'mp3');
    const unapproved = spendOf();
    const full = spendOf(1, 1);
    const approved = spendOf(1);

    await hearClip(join(voices, clip), 'nb-NO', token, unapproved, 3);
    await hearClip(join(voices, clip), 'nb-NO', token, full, 3);
    expect(send).not.toHaveBeenCalled();
    await hearClip(join(voices, clip), 'nb-NO', token, approved, 3);

    expect(send).toHaveBeenCalledTimes(1);
    expect(approved.spentUsd).toBeGreaterThan(0);
    expect(unapproved.spentUsd).toBe(0);
  });
});
