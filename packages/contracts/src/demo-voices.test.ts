import { describe, expect, it } from 'vitest';
import {
  approvalUsd,
  demoVoiceProviders,
  demoVoices,
  filmCostUsd,
  maxCostCapUsd,
  silentVoice,
  takesOf,
  voiceCostUsd,
  voiceNeedsApproval,
} from './demo-voices.js';

const lines = Array.from(
  { length: 19 },
  () => 'Her ser du hvordan en kommune setter opp en tjeneste med innlogging fra Altinn.',
);

describe('demo voices and their cost', () => {
  it('asks for approval for a voice read by a model, and not for Azure Speech', () => {
    expect(voiceNeedsApproval('cedar')).toBe(true);
    expect(voiceNeedsApproval('nb-NO-PernilleNeural')).toBe(false);
    expect(voiceNeedsApproval('de-DE-KatjaNeural')).toBe(false);
  });

  it('lists every voice under a provider that is available', () => {
    const available = demoVoiceProviders.filter((p) => p.available).map((p) => p.id);
    expect(demoVoices.every((v) => available.includes(v.provider))).toBe(true);
  });

  it('offers an ElevenLabs voice that needs approval and is read up to four times', () => {
    expect(demoVoiceProviders.find((p) => p.id === 'elevenlabs')?.available).toBe(true);
    expect(voiceNeedsApproval('elevenlabs-film')).toBe(true);
    expect(takesOf('elevenlabs-film')).toBe(4);
    expect(takesOf('nb-NO-PernilleNeural')).toBe(1);
  });

  it('prices a film without a voice at nothing and asks no approval for it', () => {
    expect(voiceCostUsd(lines, silentVoice)).toBe(0);
    expect(voiceNeedsApproval(silentVoice)).toBe(false);
  });

  it('prices ElevenLabs by the character, and the four-minute walkthrough under the platform cap', () => {
    const walkthrough = Array.from({ length: 30 }, () => 'x'.repeat(160));
    expect(voiceCostUsd(['x'.repeat(2000)], 'elevenlabs-film')).toBeGreaterThan(
      voiceCostUsd(['x'.repeat(1000)], 'elevenlabs-film'),
    );
    expect(filmCostUsd(walkthrough, 'elevenlabs-film')).toBeLessThan(maxCostCapUsd);
  });

  it('prices a model voice above Azure Speech, and a full film of 19 lines under the platform cap', () => {
    expect(voiceCostUsd(lines, 'cedar')).toBeGreaterThan(voiceCostUsd(lines, 'nb-NO-FinnNeural'));
    expect(filmCostUsd(lines, 'cedar')).toBeLessThan(maxCostCapUsd);
  });

  it('asks a person to approve whole dollars, at least one and never more than the platform cap', () => {
    expect(approvalUsd(0.02)).toBe(1);
    expect(approvalUsd(3.2)).toBe(4);
    expect(approvalUsd(400)).toBe(maxCostCapUsd);
  });
});
