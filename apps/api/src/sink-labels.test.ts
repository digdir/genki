import { describe, expect, it } from 'vitest';
import { InMemorySinkLabelStore, type SinkLabel, type StoredRun } from '@genai/eval';
import { sinkLabels } from './sink-labels.js';
import type { SinkAnnotation, TraceConnection } from './trace-connections.js';

const agencyA = '991825827';
const agencyB = '974760673';
const rule = 'svar_oppfyller_kriteriene';
const evaluator = `langfuse:lokal/${rule}`;
const identityOf = (tenant: string, version: number, connection = 'lokal', name = rule) =>
  `langfuse:${tenant}/${connection}/${name}@v${version}+foundry-claude/claude-sonnet-5`;

/** A run sent through the connection lokal, whose sink judge scored case o1 as good. */
const runOf = (tenant: string, id: string, version = 1): StoredRun =>
  ({
    tenant,
    task: `oppgave-${id}`,
    run: {
      id,
      tested: { version: 1, sink: 'lokal' },
      provenance: { judges: [identityOf(tenant, version)] },
      results: [
        {
          case: 'o1',
          repeat: 0,
          task: `${id}-o1`,
          scores: [
            {
              evaluator,
              state: 'scored',
              applicable: true,
              value: 1,
              details: { dataType: 'BOOLEAN', scoreName: rule },
            },
          ],
        },
      ],
    },
  }) as unknown as StoredRun;

const setup = (runs: StoredRun[], annotations: Record<string, SinkAnnotation[]>) => {
  const store = new InMemorySinkLabelStore();
  const labels = sinkLabels({
    store,
    runs: { list: async ({ tenant }) => runs.filter((r) => r.tenant === tenant) },
    connection: async (_tenant, id) => ({ id, labels: true }) as TraceConnection,
    sinks: {
      traceIdOf: (task) => `spor-${task}`,
      isSinkJudge: (judge) => judge.startsWith('langfuse:'),
      calibrationKey: (tenant, e) => e.replace(/^langfuse:/, `langfuse:${tenant}/`),
      annotations: async (tenant) => annotations[tenant] ?? [],
    },
  });
  return { store, labels };
};

const annotation = (trace: string, author: string, id: string): SinkAnnotation => ({
  id,
  revision: '2026-11-02T10:00:00.000Z',
  trace,
  name: rule,
  dataType: 'BOOLEAN',
  label: 'good',
  author,
});

describe('labels brought back from a trace sink', () => {
  it('keeps the labeller as a pseudonym per agency', async () => {
    const { labels } = setup([runOf(agencyA, 'kjoring-a'), runOf(agencyB, 'kjoring-b')], {
      [agencyA]: [
        annotation('spor-kjoring-a-o1', 'lf-bruker-1', 'a1'),
        annotation('spor-kjoring-a-o1', 'lf-bruker-2', 'a2'),
      ],
      [agencyB]: [annotation('spor-kjoring-b-o1', 'lf-bruker-1', 'b1')],
    });

    await labels.fetch(agencyA, 'lokal');
    await labels.fetch(agencyB, 'lokal');
    const labellerOf = async (tenant: string) =>
      (await labels.batches(tenant)).flatMap((b) => b.labels.map((l) => l.labeller));
    const [a1, a2] = await labellerOf(agencyA);
    const [b1] = await labellerOf(agencyB);

    expect(a1).toMatch(/^pseudonym:[0-9a-f]{12}$/);
    expect(a1).not.toBe(a2);
    // The same Langfuse user is someone else in another agency.
    expect(b1).toMatch(/^pseudonym:[0-9a-f]{12}$/);
    expect(b1).not.toBe(a1);
    expect(JSON.stringify(await labels.batches(agencyA))).not.toContain('lf-bruker');
    // And the same person within one agency.
    await labels.fetch(agencyA, 'lokal');
    expect(await labellerOf(agencyA)).toEqual([a1, a2]);
  });

  it('lets a new judge version take over labels only from the same tenant, connection and name', async () => {
    const run = runOf(agencyA, 'kjoring-ny', 2);
    const { store, labels } = setup([run], {});
    const accepted = (
      over: Partial<SinkLabel> & Pick<SinkLabel, 'id' | 'judge' | 'identity'>,
    ): SinkLabel => ({
      revision: 'r1',
      connection: 'lokal',
      run: 'kjoring-gammel',
      case: over.id,
      repeat: 0,
      humanLabel: 'good',
      judgeLabel: 'good',
      labeller: 'pseudonym:000000000001',
      state: 'accepted',
      fetchedAt: '2026-11-02T10:00:00.000Z',
      ...over,
    });
    const same = `langfuse:${agencyA}/lokal/${rule}`;
    await store.save(agencyA, [
      // An earlier version of the same judge, and this version.
      accepted({ id: 'v1', judge: same, identity: identityOf(agencyA, 1) }),
      accepted({ id: 'v2', judge: same, identity: identityOf(agencyA, 2), humanLabel: 'bad' }),
      // Another connection, and another judge of the same agency.
      accepted({
        id: 'annen-kobling',
        connection: 'annen',
        judge: `langfuse:${agencyA}/annen/${rule}`,
        identity: identityOf(agencyA, 1, 'annen'),
      }),
      accepted({
        id: 'annen-dommer',
        judge: `langfuse:${agencyA}/lokal/svar_er_kort`,
        identity: identityOf(agencyA, 1, 'lokal', 'svar_er_kort'),
      }),
    ]);
    // The same connection and name in another agency.
    await store.save(agencyB, [
      accepted({
        id: 'annen-virksomhet',
        judge: `langfuse:${agencyB}/lokal/${rule}`,
        identity: identityOf(agencyB, 2),
      }),
    ]);

    const agreement = (await labels.agreements(agencyA, run.run)).get(evaluator);

    expect(agreement).toEqual({
      n: 2,
      kappa: 0,
      observed: 0.5,
      otherVersions: 1,
      unpaired: 0,
    });
  });
});
