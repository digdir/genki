import { describe, expect, it } from 'vitest';
import type { Event } from '@genai/contracts';
import { createKernel, type Capability } from '@genai/kernel';
import {
  bundledJudge,
  parseJudgePrompt,
  parseTestSetYaml,
  rubricJudge,
  type EvalContext,
} from '@genai/eval';
import { BlobPortProvider, InMemoryBlobStore, jsonArtifact, partText } from '@genai/port-blob';
import { ModelError } from '@genai/port-model';
import { singleCall } from '@genai/strategy-single-call';
import {
  batchResultMime,
  batchStrategy,
  klarsprakChecklist,
  scoreBatch,
  systemPrincipal,
  type BatchResult,
} from './index.js';
import {
  fakeModels,
  lastUser,
  letters,
  publishedStore,
  readExample,
  tenant,
} from './kit.test-utils.js';

const testSet = parseTestSetYaml(readExample('testsets/klarsprak-brev.yaml'));
const reference = (text: string) =>
  testSet.spec.cases.find(
    (c) => typeof c.input === 'string' && text.includes(c.input.slice(0, 60)),
  );

const setup = async (reply: (caseId: string | undefined, call: number) => string | Error) => {
  const store = await publishedStore();
  const compiled = (await store.capabilities()).find((c) => c.service.id === 'klarsprak');
  if (!compiled) throw new Error('klarsprak did not compile');
  const counts = new Map<string, number>();
  const models = fakeModels((request) => {
    const found = reference(lastUser(request));
    const key = found?.id ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const answer = reply(found?.id, counts.get(key) ?? 1);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const blobs = new InMemoryBlobStore();
  for (const letter of letters())
    await blobs.put(
      { tenant, path: `klarsprak/innboks/${letter.file}` },
      new TextEncoder().encode(letter.text),
      'text/plain',
    );
  const batch: Capability = {
    descriptor: {
      ...compiled.capability.descriptor,
      id: `${tenant}/klarsprak/batch`,
      title: 'Klarspråk, batch',
    },
    strategy: { id: 'batch', version: '1' },
    config: {
      strategy: {
        capability: compiled.capability.descriptor.id,
        folder: 'klarsprak',
        concurrency: 3,
        retries: 1,
        backoffMs: 0,
      },
      tenant,
    },
    grants: [{ port: 'blob', ref: { kind: 'blob-folder', id: 'klarsprak', tenant } }],
  };
  const kernel = createKernel({
    strategies: [singleCall, batchStrategy],
    capabilities: [compiled.capability, batch],
    ports: { model: models, blob: new BlobPortProvider(blobs) },
    policy: { decide: async () => ({ allow: true }) },
  });
  return { kernel, blobs, models, counts, batchId: batch.descriptor.id };
};

const plain = (caseId: string | undefined) =>
  JSON.stringify({
    text: testSet.spec.cases.find((c) => c.id === caseId)?.expected.referenceAnswer ?? 'ukjent',
    changes: ['Skrev det viktigste først', 'Brukte du og aktive verb'],
  });

const runBatch = async (
  kernel: Awaited<ReturnType<typeof setup>>['kernel'],
  capability: string,
  batchId: string,
) => {
  const run = await kernel.invoke(systemPrincipal()(tenant), capability, {
    data: { batchId, folder: 'innboks' },
  });
  const events: Event[] = [];
  for await (const e of run.events) events.push(e);
  const parts = await run.result;
  const json = parts.find((p) => p.mime === batchResultMime);
  return {
    parts,
    events,
    result: (json?.body.kind === 'json' ? json.body.json : undefined) as BatchResult,
    task: run.task,
  };
};

const evalContext: EvalContext = {
  servedModels: ['gpt-4o-test'],
  modelFamily: (m) => (m.startsWith('gpt') ? 'openai' : undefined),
};

describe('batch jobs', () => {
  it('rewrites a folder of letters in klarspråk, retries a passing failure, and writes a scored result file', async () => {
    const { kernel, blobs, batchId } = await setup((caseId, call) =>
      caseId === 'avslag-klagerett' && call === 1
        ? new ModelError('unavailable', 'busy')
        : plain(caseId),
    );

    const { result, events, parts } = await runBatch(kernel, batchId, 'brev-oktober');

    expect(result).toMatchObject({ batchId: 'brev-oktober', total: 6, succeeded: 6, failed: 0 });
    expect(result.items.find((i) => i.id === 'avslag-klagerett')).toMatchObject({
      status: 'succeeded',
      attempts: 2,
    });
    expect(
      events.filter(
        (e) =>
          e.type === 'kernel.notice' && (e.data as { kind?: string }).kind === 'batch-progress',
      ),
    ).toHaveLength(6);
    const file = parts.find((p) => p.body.kind === 'blob');
    expect(file && JSON.parse((await partText(blobs, file, tenant)) ?? '')).toMatchObject({
      succeeded: 6,
    });

    const judge = rubricJudge(
      {
        id: 'claude-test',
        family: 'anthropic',
        complete: async () =>
          JSON.stringify({
            scores: {
              'meaning-preserved': 5,
              'important-first': 4,
              'plain-words': 4,
              'direct-and-active': 5,
              structure: 4,
            },
            rationale: 'Klar og fullstendig.',
          }),
      },
      parseJudgePrompt(readExample('judges/klarsprak-checklist.yaml')),
    );
    const score = await scoreBatch(result, testSet, [klarsprakChecklist(), judge], evalContext);
    const scored = await jsonArtifact(
      blobs,
      { tenant, path: 'klarsprak/results/brev-oktober.scored.json' },
      { ...result, score },
    );

    expect(score.cases).toHaveLength(6);
    expect(score.unmatched).toEqual([]);
    expect(score.metrics['klarsprak.overall']?.mean).toBeGreaterThan(0.6);
    expect(score.metrics['judge.overall']?.mean).toBeCloseTo(0.85, 2);
    expect(
      JSON.parse((await partText(blobs, scored, tenant)) ?? '').score.metrics[
        'klarsprak.direct-address'
      ].mean,
    ).toBe(1);
  });

  it('records a permanent failure without stopping the others, and a rerun of the same batch only redoes that item', async () => {
    let broken = true;
    const { kernel, models, batchId } = await setup((caseId) =>
      caseId === 'innkalling-mote' && broken ? 'ikke json' : plain(caseId),
    );

    const first = await runBatch(kernel, batchId, 'brev-november');
    broken = false;
    const callsBefore = models.calls.length;
    const second = await runBatch(kernel, batchId, 'brev-november');

    expect(first.result).toMatchObject({ succeeded: 5, failed: 1 });
    expect(first.result.items.find((i) => i.id === 'innkalling-mote')).toMatchObject({
      status: 'failed',
      attempts: 2,
    });
    expect(models.calls.length - callsBefore).toBe(1);
    expect(second.result).toMatchObject({ succeeded: 6, failed: 0 });
  });

  it('runs a batch over items given directly, without a folder', async () => {
    const { kernel, batchId } = await setup((caseId) => plain(caseId));
    const letter = letters()[0];
    if (!letter) throw new Error('no letters');

    const run = await kernel.invoke(systemPrincipal()(tenant), batchId, {
      data: {
        items: [
          {
            id: letter.id,
            input: { parts: [{ mime: 'text/plain', body: { kind: 'text', text: letter.text } }] },
          },
        ],
      },
    });
    const json = (await run.result).find((p) => p.mime === batchResultMime);

    expect(json?.body.kind === 'json' && (json.body.json as BatchResult).succeeded).toBe(1);
  });

  it('keeps the bundled answer-quality judge usable for references', () => {
    expect(bundledJudge('answer-quality').criteria.length).toBeGreaterThan(0);
  });
});
