import { textPart } from '@genai/contracts';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { builtinBlocks } from './builtins.js';
import {
  collect,
  loadFlow,
  fakeModels,
  kari,
  notices,
  run,
  setup,
  steps,
  unavailable,
} from './harness.test-utils.js';

const definitionsExample = (name: string) =>
  loadFlow(join(import.meta.dirname, '..', '..', 'definitions', 'examples', name));

const classification = (label: string) => JSON.stringify({ label, reason: 'test' });

describe('step-flow runtime', () => {
  it('runs the definitions package example: classify, then route by the label', async () => {
    const flow = definitionsExample('postsortering-flyt.yaml');
    const complaint = await run(
      {
        flows: [flow],
        entry: 'postsortering-flyt@1',
        models: fakeModels({ primary: [classification('klage')] }),
      },
      { parts: [textPart('Jeg klager på vedtaket.')] },
    );
    const other = await run(
      {
        flows: [flow],
        entry: 'postsortering-flyt@1',
        models: fakeModels({ primary: [classification('tilskudd')] }),
      },
      { parts: [textPart('Søknad om tilskudd.')] },
    );

    expect(complaint.task.status).toBe('completed');
    expect(complaint.result).toEqual([
      { mime: 'application/json', body: { kind: 'json', json: { queue: 'klager' } } },
    ]);
    expect(other.result).toEqual([
      { mime: 'application/json', body: { kind: 'json', json: { queue: 'post-generell' } } },
    ]);
    expect(complaint.models.seen[0]?.request.messages.at(-1)?.content).toContain(
      'Jeg klager på vedtaket.',
    );
    expect(notices(complaint.events)).toContainEqual({
      kind: 'route',
      step: 'to-complaints',
      queue: 'klager',
    });
  });

  it('repeats until the condition holds, and reports when it ran out of iterations', async () => {
    const flow = (max: number) =>
      steps('loop', [
        {
          id: 'retry',
          repeat: {
            until: "ask.text == 'ferdig'",
            max,
            steps: [
              { id: 'ask', block: 'model@1', input: { prompt: 'Runde {{vars.loop.index}}' } },
            ],
          },
        },
      ]);
    const models = () => fakeModels({ primary: ['ikke ennå', 'ikke ennå', 'ferdig'] });

    const done = await run({ flows: [flow(5)], entry: 'loop@1', models: models() });
    const short = await run({ flows: [flow(2)], entry: 'loop@1', models: models() });

    expect(done.result).toEqual([
      {
        mime: 'application/json',
        body: {
          kind: 'json',
          json: {
            iterations: [{ text: 'ikke ennå' }, { text: 'ikke ennå' }, { text: 'ferdig' }],
            last: { text: 'ferdig' },
            exhausted: false,
          },
        },
      },
    ]);
    expect(done.models.seen.map((s) => s.request.messages[0]?.content)).toEqual([
      'Runde 0',
      'Runde 1',
      'Runde 2',
    ]);
    expect(
      (short.result as { body: { json: { exhausted: boolean } } }[])[0]?.body.json.exhausted,
    ).toBe(true);
  });

  it('runs steps for each item and collects one output per item', async () => {
    const flow = steps('each', [
      {
        id: 'greet',
        forEach: {
          in: 'input.names',
          as: 'name',
          steps: [
            {
              id: 'line',
              block: 'template@1',
              input: { text: 'Hei, {{name}} ({{vars.loop.index}})' },
            },
          ],
        },
      },
    ]);

    const out = await run({ flows: [flow], entry: 'each@1' }, { data: { names: ['Kari', 'Ola'] } });

    expect(out.result).toEqual([
      {
        mime: 'application/json',
        body: { kind: 'json', json: [{ text: 'Hei, Kari (0)' }, { text: 'Hei, Ola (1)' }] },
      },
    ]);
  });

  it('calls a subflow with its own input and refuses a flow that calls itself', async () => {
    const inner = steps('inner', [
      { id: 'echo', block: 'template@1', input: { text: 'Indre: {{input.word}}' } },
    ]);
    const outer = steps('outer', [
      { id: 'call', subflow: 'inner@1', input: { word: 'hallo' } },
      { id: 'wrap', block: 'template@1', input: { text: 'Ytre fikk {{call.text}}' } },
    ]);
    const loop = steps('selfish', [{ id: 'again', subflow: 'selfish@1' }]);

    const ok = await run({ flows: [inner, outer], entry: 'outer@1' });
    const bad = await run({ flows: [loop], entry: 'selfish@1' });

    expect(ok.result).toEqual([
      {
        mime: 'application/json',
        body: { kind: 'json', json: { text: 'Ytre fikk Indre: hallo' } },
      },
    ]);
    expect(bad.task.status).toBe('failed');
  });

  it('stops on a failing step by default, skips it or uses its default when told to', async () => {
    const flow = (onError: Record<string, unknown>) =>
      steps('errors', [
        { id: 'ask', block: 'model@1', input: { prompt: 'x' }, ...onError },
        {
          id: 'after',
          block: 'template@1',
          input: { text: 'Fikk: {{ask.text ?? ask.fallback ?? "ingenting"}}' },
        },
      ]);
    const failing = () => fakeModels({ primary: [unavailable()] });

    const stopped = await run({ flows: [flow({})], entry: 'errors@1', models: failing() });
    const skipped = await run({
      flows: [flow({ onError: 'skip' })],
      entry: 'errors@1',
      models: failing(),
    });
    const defaulted = await run({
      flows: [flow({ onError: 'use-default', default: { fallback: 'standardsvar' } })],
      entry: 'errors@1',
      models: failing(),
    });

    expect(stopped.task.status).toBe('failed');
    expect(skipped.result).toEqual([
      { mime: 'application/json', body: { kind: 'json', json: { text: 'Fikk: ingenting' } } },
    ]);
    expect(notices(skipped.events)).toContainEqual(
      expect.objectContaining({ kind: 'step', step: 'ask', status: 'skipped' }),
    );
    expect(defaulted.result).toEqual([
      { mime: 'application/json', body: { kind: 'json', json: { text: 'Fikk: standardsvar' } } },
    ]);
  });

  it('falls back to the second model when the first is unavailable', async () => {
    const flow = steps('fallback', [{ id: 'ask', block: 'model@1', input: { prompt: 'x' } }]);

    const out = await run({
      flows: [flow],
      entry: 'fallback@1',
      fallback: true,
      models: fakeModels({ primary: [unavailable()], fallback: ['fra reserven'] }),
    });

    expect(out.result).toEqual([
      { mime: 'application/json', body: { kind: 'json', json: { text: 'fra reserven' } } },
    ]);
  });

  it('fails a flow that runs more steps than its budget', async () => {
    const flow = steps('busy', [
      {
        id: 'spin',
        repeat: {
          until: 'false',
          max: 20,
          steps: [{ id: 'tick', block: 'template@1', input: { text: 't' } }],
        },
      },
    ]);

    const out = await run({ flows: [flow], entry: 'busy@1', strategy: { maxSteps: 5 } });

    expect(out.task.status).toBe('failed');
  });

  it('stops when the task is cancelled', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const models = fakeModels({
      primary: [
        async () => {
          await blocked;
          return 'for sent';
        },
      ],
    });
    const flow = steps('slow', [
      { id: 'ask', block: 'model@1', input: { prompt: 'x' } },
      { id: 'never', block: 'template@1', input: { text: 'skal ikke kjøre' } },
    ]);
    const { kernel } = setup({ flows: [flow], entry: 'slow@1', models });

    const started = await kernel.invoke(kari, 'flow', { parts: [textPart('x')] });
    await kernel.cancel(kari, started.task);
    release();
    await started.result.catch(() => undefined);

    expect((await kernel.task(kari, started.task)).status).toBe('cancelled');
  });

  it('pauses for approval, resumes from the checkpoint, and does not rerun finished steps', async () => {
    const flow = steps('approve', [
      { id: 'draft', block: 'model@1', input: { prompt: 'Skriv et utkast' } },
      {
        id: 'check',
        block: 'approval@1',
        params: { reason: 'review', prompt: 'Godkjenn utkastet: {{draft.text}}' },
      },
      {
        id: 'final',
        block: 'template@1',
        input: { text: '{{draft.text}} (godkjent: {{check.approved}})' },
      },
    ]);
    const { kernel, models } = setup({
      flows: [flow],
      entry: 'approve@1',
      models: fakeModels({ primary: ['Utkast'] }),
    });

    const first = await kernel.invoke(kari, 'flow', { parts: [textPart('x')] });
    await expect(first.result).rejects.toMatchObject({ code: 'interrupted' });
    const paused = await kernel.task(kari, first.task);
    const second = await kernel.resume(kari, first.task, 'step:check', {
      data: { approved: true },
    });
    const result = await second.result;

    expect(paused.status).toBe('interrupted');
    expect(paused.pendingInterrupt?.prompt).toEqual([textPart('Godkjenn utkastet: Utkast')]);
    expect(result).toEqual([
      {
        mime: 'application/json',
        body: { kind: 'json', json: { text: 'Utkast (godkjent: true)' } },
      },
    ]);
    expect(models.seen).toHaveLength(1);
  });

  it('reports each step as it starts and finishes', async () => {
    const flow = steps('trace', [
      { id: 'one', block: 'template@1', input: { text: 'a' } },
      { id: 'two', block: 'template@1', input: { text: 'b' } },
    ]);

    const out = await run({ flows: [flow], entry: 'trace@1' });

    expect(
      notices(out.events)
        .filter((n) => n.kind === 'step')
        .map((n) => `${String(n.step)}:${String(n.status)}`),
    ).toEqual(['one:started', 'one:done', 'two:started', 'two:done']);
  });

  it('streams answer text from a model step when asked', async () => {
    const flow = steps('stream', [
      { id: 'ask', block: 'model@1', input: { prompt: 'x' }, params: { stream: true } },
    ]);
    const { kernel } = setup({
      flows: [flow],
      entry: 'stream@1',
      models: fakeModels({ primary: ['Hei der verden'] }, { stream: true }),
    });

    const started = await kernel.invoke(kari, 'flow', { parts: [textPart('x')] });
    const events = await collect(started.events);

    const deltas = events
      .filter((e) => e.type === 'kernel.part.delta')
      .map((e) => (e.data as { text: string }).text);
    expect(deltas[0]).toBe('Hei ');
    expect(deltas.join('')).toBe('Hei der verden');
  });

  it('refuses a step output that breaks the block contract', async () => {
    const blocks = builtinBlocks().register({
      name: 'liar',
      version: '1',
      description: 'returns the wrong shape',
      input: z.looseObject({}),
      params: z.strictObject({}),
      output: z.strictObject({ ok: z.literal(true) }),
      run: async function* () {
        yield* [];
        return { ok: 'nope' };
      },
    });
    const flow = steps('liar', [{ id: 'lie', block: 'liar@1' }]);

    const out = await run({ flows: [flow], entry: 'liar@1', blocks });

    expect(out.task.status).toBe('failed');
  });

  it('refuses to register the same block twice', () => {
    const model = builtinBlocks().get('model@1');
    if (!model) throw new Error('model@1 is missing');
    expect(() => builtinBlocks().register(model)).toThrow(/already registered/);
  });
});
