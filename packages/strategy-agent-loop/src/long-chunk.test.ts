import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { serviceDefinition } from '@genai/definitions';
import { baseConfig, call, chunk, result, retrieval, run } from './harness.test-utils.js';
import { agentLoopConfig, type AgentLoopRuntimeConfig, type Chunk } from './index.js';

const filler = (n: number, length: number) =>
  `Bakgrunn ${n}. ` +
  'Datatilsynet har mange oppgaver og roller i forvaltningen. '.repeat(length / 60);
const answer = 'Saksbehandlingstiden på klagesaker er på rundt ett år (365 dager i 2023).';
const table =
  '| År | Klager | Dager |\n|---|---|---|\n| 2022 | 300 | 280 |\n| 2023 | 320 | 365 |\n';
const longContent = filler(9, 4400) + table + answer;

const store = () => {
  const chunks = new Map<string, Chunk>();
  for (let n = 1; n <= 8; n += 1) {
    const content = filler(n, 1250);
    chunks.set(
      `c${n}`,
      chunk(n, {
        document: `d${(n % 4) + 1}`,
        position: n,
        content,
        contentLength: content.length,
      }),
    );
  }
  chunks.set(
    'c9',
    chunk(9, {
      document: 'd1',
      position: 9,
      content: longContent,
      contentLength: longContent.length,
    }),
  );
  return chunks;
};

const seedBudget = (): AgentLoopRuntimeConfig['strategy']['budget'] => {
  const file = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'apps',
    'api',
    'config',
    'local',
    'services',
    'kunnskapsassistenten.yaml',
  );
  const definition = serviceDefinition.parse(parseYaml(readFileSync(file, 'utf8')));
  return agentLoopConfig.parse(definition.spec.strategy.config).budget;
};

describe('the local Kunnskapsassistenten', () => {
  it('reads an answer that sits last in a long chunk ranked behind short ones', async () => {
    let prompt = '';
    await run({
      retrieval: retrieval({}, store()).impl,
      config: { ...baseConfig, strategy: { budget: seedBudget() } },
      question:
        'Kor lang tid brukar Datatilsynet på å behandle klager, ifølgje evalueringa til DFØ?',
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['Datatilsynet klager behandlingstid'] })]),
            () =>
              result('', [
                call('read_chunks', { chunk_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `c${n}`) }),
              ]),
            () => result('', [call('read_chunks', { chunk_ids: ['c9'] })]),
            () => result('', [call('generate_response', { query: 'q' })]),
          ],
          synth: [(r) => ((prompt = r.messages[1]?.content ?? ''), 'Svar [1].')],
        },
      },
    });

    expect(prompt).toContain('rundt ett år');
  });
});
