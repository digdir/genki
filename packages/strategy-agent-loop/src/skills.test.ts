import { describe, expect, it } from 'vitest';
import { baseConfig, call, result, run, toolMessages } from './harness.test-utils.js';
import { defaultSystemPrompt } from './index.js';

const klarsprak = (version: number, instructions: string) => ({
  ref: `klarsprak@${version}`,
  name: 'klarsprak',
  description: 'Skriv om tekst til klarspråk.',
  instructions,
  examples: [{ input: 'Vedtaket er fattet.', expectedOutput: 'Vi har bestemt.' }],
});

describe('agent-loop skills', () => {
  it('use_skill returns the pinned instructions', async () => {
    const out = await run({
      config: { ...baseConfig, skills: [klarsprak(2, 'Bruk korte setninger. Versjon 2.')] },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('use_skill', { name: 'klarsprak' })]),
            () => result('Vi har bestemt.'),
          ],
        },
      },
    });

    const [first, second] = out.loops;
    expect(first?.tools?.map((t) => t.name)).toContain('use_skill');
    expect(first?.messages[0]?.content).toBe(
      `${defaultSystemPrompt}\n\n# Ferdigheter\n\nThese skills are available. Call use_skill with the name to load a skill's instructions when the question needs it:\n- klarsprak: Skriv om tekst til klarspråk.`,
    );
    expect(toolMessages(second)).toEqual([
      '## klarsprak\nSkriv om tekst til klarspråk.\n\nBruk korte setninger. Versjon 2.\n\nEksempler:\nInn: Vedtaket er fattet.\nForventet resultat: Vi har bestemt.',
    ]);
    expect(out.text).toBe('Vi har bestemt.');
  });

  it('a service without skills gets exactly the same prompt and tools as before', async () => {
    const script = { primary: { loop: [() => result('Svar.')] } };
    const before = await run({ scripts: script });
    const empty = await run({ config: { ...baseConfig, skills: [] }, scripts: script });

    expect(empty.loops).toEqual(before.loops);
    expect(before.loops[0]?.messages[0]?.content).toBe(defaultSystemPrompt);
    expect(before.loops[0]?.tools?.map((t) => t.name)).not.toContain('use_skill');
  });
});
