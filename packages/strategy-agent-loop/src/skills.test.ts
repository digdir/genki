import { describe, expect, it } from 'vitest';
import {
  baseConfig,
  call,
  decision,
  readSignal,
  result,
  run,
  toolMessages,
} from './harness.test-utils.js';
import {
  ablatableStages,
  defaultGenerationPrompt,
  defaultSystemPrompt,
  generationPromptFor,
  skillText,
  systemPromptWithDate,
} from './index.js';
import { untrustedDataNote } from './prompts.js';

const klarsprak = (version: number, instructions: string) => ({
  ref: `klarsprak@${version}`,
  name: 'klarsprak',
  description: 'Skriv om tekst til klarspråk.',
  instructions,
  examples: [{ input: 'Vedtaket er fattet.', expectedOutput: 'Vi har bestemt.' }],
});

const skill = klarsprak(2, 'Bruk korte setninger. Behold {context} og {question} bokstavelig.');
const synthesisSystem = systemPromptWithDate(new Date('2026-10-06T10:00:00Z'));
const ungated = { ...baseConfig.strategy, ablate: [...ablatableStages] };

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
      `${defaultSystemPrompt}\n\n# Ferdigheter\n\nThese skills are available. Call use_skill with the name to load a skill's instructions when the question needs it:\n- klarsprak: Skriv om tekst til klarspråk.${untrustedDataNote}`,
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
    expect(before.loops[0]?.messages[0]?.content).toBe(defaultSystemPrompt + untrustedDataNote);
    expect(before.loops[0]?.tools?.map((t) => t.name)).not.toContain('use_skill');
  });

  it.each([undefined, 'Custom context: {context}\nQuestion: {question}'])(
    'passes loaded instructions and examples to synthesis with generationPrompt=%s',
    async (generationPrompt) => {
      const out = await run({
        config: {
          ...baseConfig,
          model: { ...baseConfig.model, roles: { synthesis: 'fallback' } },
          strategy: { ...ungated, ...(generationPrompt ? { generationPrompt } : {}) },
          skills: [skill],
        },
        scripts: {
          primary: {
            loop: [
              () => result('', [call('use_skill', { name: skill.name })]),
              () => result('', [call('generate_response', { query: 'Svar kort.' })]),
            ],
          },
          fallback: { loop: [], synth: [() => 'Vi har bestemt.'] },
        },
        stream: true,
      });

      const synthesis = out.seen.filter((s) => s.kind === 'synth');
      expect(synthesis).toHaveLength(1);
      expect(synthesis[0]?.model).toBe('fallback');
      expect(synthesis[0]?.request.messages).toEqual([
        { role: 'system', content: `${synthesisSystem}\n\n# Ferdigheter\n\n${skillText(skill)}` },
        {
          role: 'user',
          content: generationPromptFor(
            generationPrompt ?? defaultGenerationPrompt,
            '',
            'Svar kort.',
          ),
        },
      ]);
      expect(out.text).toBe('Vi har bestemt.');
    },
  );

  it('includes each successfully loaded skill once, in load order, and excludes unused skills', async () => {
    const second = { ...klarsprak(1, 'Svar med en tabell.'), ref: 'tabell@1', name: 'tabell' };
    const unused = { ...klarsprak(1, 'UNUSED INSTRUCTIONS'), ref: 'unused@1', name: 'unused' };
    const out = await run({
      config: { ...baseConfig, strategy: ungated, skills: [skill, second, unused] },
      scripts: {
        primary: {
          loop: [
            () =>
              result('', [
                call('use_skill', { name: second.name }),
                call('use_skill', { name: skill.name }),
                call('use_skill', { name: second.name }),
                call('use_skill', { name: 'unknown' }),
                call('use_skill', {}),
                call('generate_response', { query: 'Svar kort.' }),
              ]),
          ],
        },
      },
    });

    expect(out.seen.find((s) => s.kind === 'synth')?.request.messages[0]?.content).toBe(
      `${synthesisSystem}\n\n# Ferdigheter\n\n${skillText(second)}\n\n${skillText(skill)}`,
    );
    expect(out.task?.status).toBe('completed');
  });

  it('passes loaded skills to synthesis forced by the sufficiency gate after a read', async () => {
    const out = await run({
      config: { ...baseConfig, skills: [skill] },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('use_skill', { name: skill.name })]),
            () => result('', [call('search', { queries: ['tildelingsbrev'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
          ],
        },
      },
    });

    expect(out.loops).toHaveLength(3);
    expect(out.seen.find((s) => s.kind === 'synth')?.request.messages[0]?.content).toContain(
      skillText(skill),
    );
    expect(out.text).toBe('Svar [1].');
  });

  it('retains loaded skills when a rejected synthesis is retried', async () => {
    const out = await run({
      config: { ...baseConfig, skills: [skill] },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('use_skill', { name: skill.name })]),
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining', { scope_assessment: 'ambiguous' })],
          sufficiency: [
            () => decision('insufficient', 're-search'),
            () => decision('sufficient', 'finalize'),
            () => decision('sufficient', 'finalize'),
          ],
          synth: [() => 'Første utkast [1].', () => 'Bedre svar [1].'],
        },
      },
    });

    const syntheses = out.seen.filter((s) => s.kind === 'synth');
    expect(syntheses).toHaveLength(2);
    for (const s of syntheses) expect(s.request.messages[0]?.content).toContain(skillText(skill));
    expect(out.text).toBe('Bedre svar [1].');
  });

  it('passes loaded skills to citation backfill after the loop answers directly', async () => {
    const out = await run({
      config: { ...baseConfig, skills: [skill] },
      scripts: {
        primary: {
          loop: [
            () => result('', [call('use_skill', { name: skill.name })]),
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('Svaret er 42.'),
          ],
        },
      },
    });

    expect(toolMessages(out.loops[2])).toContain(skillText(skill));
    expect(out.seen.find((s) => s.kind === 'synth')?.request.messages[0]?.content).toContain(
      skillText(skill),
    );
    expect(out.notices).toContainEqual({ stage: 'citations', action: 'backfill', adopted: true });
    expect(out.text).toBe('Svar [1].');
  });

  it.each(['empty-answer', 'exhaustion'])(
    'puts loaded skills in the system prompt of %s recovery',
    async (mode) => {
      const out = await run({
        config: {
          ...baseConfig,
          skills: [skill],
          strategy: { maxIterations: mode === 'exhaustion' ? 1 : 3 },
        },
        scripts: {
          primary: {
            loop: [() => result('', [call('use_skill', { name: skill.name })]), () => result('')],
          },
        },
      });

      const recovery = out.seen.filter((s) => s.kind === 'final');
      expect(recovery).toHaveLength(1);
      expect(recovery[0]?.request.messages[0]?.content).toContain(skillText(skill));
      expect(out.text).toBe('Beste svar ut fra det jeg fant.');
    },
  );

  it('restarts empty-answer recovery from the first messages after a skill load', async () => {
    const out = await run({
      config: { ...baseConfig, skills: [skill], strategy: { maxIterations: 3 } },
      scripts: {
        primary: {
          loop: [() => result('', [call('use_skill', { name: skill.name })]), () => result('')],
        },
      },
    });

    const recovery = out.seen.find((s) => s.kind === 'final')?.request;
    expect(toolMessages(recovery)).toEqual([]);
    expect(recovery?.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
  });

  it('preserves exact synthesis prompts without a successful skill load and does not leak between runs', async () => {
    const synthesize = async (skills?: (typeof skill)[], load?: string) =>
      run({
        config: { ...baseConfig, strategy: ungated, ...(skills ? { skills } : {}) },
        scripts: {
          primary: {
            loop: [
              () =>
                result('', [
                  ...(load ? [call('use_skill', { name: load })] : []),
                  call('generate_response', { query: 'x' }),
                ]),
            ],
          },
        },
      });
    await synthesize([skill], skill.name);
    for (const out of [
      await synthesize(),
      await synthesize([]),
      await synthesize([skill]),
      await synthesize([skill], 'unknown'),
    ]) {
      expect(out.seen.find((s) => s.kind === 'synth')?.request.messages).toEqual([
        { role: 'system', content: synthesisSystem },
        { role: 'user', content: generationPromptFor(defaultGenerationPrompt, '', 'x') },
      ]);
      expect(out.text).toBe('Svar [1].');
    }
  });
});
