import { describe, expect, it } from 'vitest';
import {
  approvalUsd,
  demoVoiceProviders,
  demoVoices,
  filmCostUsd,
  maxCostCapUsd,
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
    expect(demoVoiceProviders.find((p) => p.id === 'elevenlabs')?.available).toBe(false);
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
