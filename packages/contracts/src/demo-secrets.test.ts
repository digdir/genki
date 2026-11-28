import { describe, expect, it } from 'vitest';
import { looksLikeSecret, secretPathIn } from './demo-secrets.js';

describe('key-like values in a demo', () => {
  it('finds an ElevenLabs key, an Azure key and a long random token wherever they are', () => {
    expect(
      secretPathIn({ steps: [{ say: 'Hei sk_0123456789abcdef0123456789abcdef0123456789abcdef' }] }),
    ).toBe('steps.0.say');
    expect(
      secretPathIn({ respell: { elevenlabs: { x: '3f9a1c2b7d4e8f60a1b2c3d4e5f60718' } } }),
    ).toBe('respell.elevenlabs.x');
    expect(secretPathIn({ path: '/#/x?token=Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1ONzg5' })).toBe(
      'path',
    );
  });

  it('lets ordinary demo text, selectors, paths and voice ids through', () => {
    const demo = {
      title: 'Genki, plattformen i sin helhet',
      voice: 'elevenlabs-film',
      path: '/#/services/rapportassistenten/oppsett',
      steps: [
        {
          say: 'Kunnskapsassistenten-2026-evaluering er en tjeneste med 12 kilder fra 2020 til 2026.',
        },
        { say: 'Hei', do: [['find', 'css', 'main table tbody tr:nth-child(2)', 'click']] },
        { say: 'Stemmen SAa140Q9akujSiZCBSNt leser.' },
      ],
    };
    expect(secretPathIn(demo)).toBeUndefined();
    expect(looksLikeSecret('nb-NO-PernilleNeural')).toBe(false);
    expect(
      secretPathIn({ path: '/#/services/3f2a9c1e-7b4d-4e8a-9f1c-2d3e4f5a6b7c/runs' }),
    ).toBeUndefined();
  });

  it('finds a genki API key and a GitHub token, also with few digits', () => {
    expect(looksLikeSecret('gp_AbCdEfGhIjKlMnOpQrStUvWxYz-_AbCdEf')).toBe(true);
    expect(looksLikeSecret('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBe(true);
    expect(looksLikeSecret('wJalrXUtnFEMIK7MDENGbPxRfiCY9EXAMPLEKEY')).toBe(true);
  });

  it('checks a long hostile value in linear time', () => {
    const started = performance.now();
    secretPathIn({ say: 'a1'.repeat(100_000) + '!' + 'sk_'.repeat(50_000) });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
