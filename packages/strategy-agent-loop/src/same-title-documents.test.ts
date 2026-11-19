import { describe, expect, it } from 'vitest';
import {
  baseConfig,
  call,
  chunk,
  readSignal,
  result,
  retrieval,
  run,
  toolMessages,
} from './harness.test-utils.js';

const budget = 'Prop. 1 S (2024–2025)';

/** Two ministries' budget propositions with the same title, as in Kudos (issue 754). */
const store = () =>
  new Map([
    ['c1', chunk(1, { title: budget, publisher: 'Finansdepartementet' })],
    ['c2', chunk(2, { title: budget, publisher: 'Nærings- og fiskeridepartementet' })],
    ['c3', chunk(3)],
  ]);

const searchLine = (text: string, id: string) =>
  text.split('\n').find((l) => l.includes(` chunk_id=${id} `)) ?? '';

const readHeader = (text: string, id: string) =>
  text.split('\n').find((l) => l.startsWith(`--- chunk_id=${id} `)) ?? '';

const searchThenRead = (ids: string[]) =>
  run({
    retrieval: retrieval({}, store()).impl,
    scripts: {
      primary: {
        loop: [
          () => result('', [call('search', { queries: ['Prop. 1 S Finansdepartementet'] })]),
          () => result('', [call('read_chunks', { chunk_ids: ids })]),
          () => result('Ferdig.'),
        ],
        read: [() => readSignal('support-found')],
      },
    },
  });

describe('telling same-title documents apart', () => {
  it("a search result line names the document's publisher", async () => {
    const out = await searchThenRead(['c1']);

    const text = toolMessages(out.loops[1])[0] ?? '';
    expect(searchLine(text, 'c1')).toContain(`title="${budget}" publisher="Finansdepartementet"`);
    expect(searchLine(text, 'c2')).toContain('publisher="Nærings- og fiskeridepartementet"');
    expect(searchLine(text, 'c3')).not.toBe('');
    expect(searchLine(text, 'c3')).not.toContain('publisher=');
  });

  it("a read result names the document's publisher", async () => {
    const out = await searchThenRead(['c1', 'c2', 'c3']);

    const text = toolMessages(out.loops[2])[1] ?? '';
    expect(readHeader(text, 'c1')).toContain(`title="${budget}" publisher="Finansdepartementet"`);
    expect(readHeader(text, 'c2')).toContain('publisher="Nærings- og fiskeridepartementet"');
    expect(readHeader(text, 'c3')).not.toBe('');
    expect(readHeader(text, 'c3')).not.toContain('publisher=');
  });

  it('a source the answer is written from names its publisher', async () => {
    const generated = async (citeBy: 'document' | 'excerpt') => {
      const out = await run({
        retrieval: retrieval({}, store()).impl,
        config: { ...baseConfig, strategy: { ...baseConfig.strategy, citeBy } },
        scripts: {
          primary: {
            loop: [
              () => result('', [call('search', { queries: ['Prop. 1 S Finansdepartementet'] })]),
              () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3'] })]),
              () => result('', [call('generate_response', { query: 'Prop. 1 S' })]),
              () => result('Ferdig.'),
            ],
            read: [() => readSignal('support-found')],
          },
        },
      });
      const synth = out.seen.filter((s) => s.kind === 'synth').at(-1);
      return String(synth?.request.messages.at(-1)?.content);
    };

    for (const citeBy of ['document', 'excerpt'] as const) {
      const context = await generated(citeBy);
      expect(context).toContain(
        `<untrusted_data kind="source" id="d1" title="${budget}" publisher="Finansdepartementet"`,
      );
      expect(context).toContain(
        `<untrusted_data kind="source" id="d2" title="${budget}" publisher="Nærings- og fiskeridepartementet"`,
      );
      expect(context).toContain('<untrusted_data kind="source" id="d3" title="Rapport 3">');
    }
  });

  it("the search tool tells the agent to filter by organisation to get one organisation's document", async () => {
    const out = await searchThenRead(['c1']);

    const search = out.loops[0]?.tools?.find((t) => t.name === 'search');
    expect(JSON.stringify(search?.parameters)).toContain(
      "To get one organisation's own document, such as its Prop. 1 S, tildelingsbrev or årsrapport, filter orgs_long with the organisation's name",
    );
    expect(search?.description).toContain('publisher=');
  });

  it("an organisation hint tells the agent to filter for that organisation's own document", async () => {
    const r = retrieval({}, store());
    const detected = retrieval(
      {
        search: async (queries, options, signal) => ({
          ...(await r.impl.search(queries, options, signal)),
          attribution: {
            detections: [
              {
                kind: 'organisation',
                field: 'orgs_long',
                values: ['Finansdepartementet'],
                queries,
                use: 'hint',
              },
            ],
          },
        }),
      },
      store(),
    ).impl;

    const out = await run({
      retrieval: detected,
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['Prop. 1 S Finansdepartementet'] })]),
            () => result('Svar.'),
          ],
        },
      },
    });

    expect(toolMessages(out.loops[1])[0]).toContain(
      "To get that organisation's own document, such as its Prop. 1 S, filter orgs_long with its name.",
    );
  });
});
