import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';
import {
  demoKind,
  isRecorderKey,
  stepsDone,
  readDemo,
  readDemoSeeds,
  recorderKeyDigest,
  seedDemos,
  type DemoSpec,
} from './demos.js';

const yaml = (extra = '') => `title: Prøv en tjeneste
language: nb-NO
voice: nb-NO-PernilleNeural
start: https://portal.genki-test.digdir.cloud/#/playground
steps:
  - say: Først velger vi hva vi vil prøve.
    do:
      - [wait, --text, Hva vil du prøve?, --timeout, 30000]
${extra}`;

const spec = (title = 'Prøv en tjeneste'): DemoSpec => {
  const read = readDemo(yaml());
  if (!read.ok) throw new Error('fixture is invalid');
  return { ...read.spec, title };
};

describe('demo records', () => {
  it('reads every demo in the repository', () => {
    const { seeds, unreadable } = readDemoSeeds(
      join(import.meta.dirname, '..', '..', '..', 'demos'),
    );

    expect(unreadable).toEqual([]);
    expect(seeds.length).toBeGreaterThan(0);
  });

  it('turns a start URL into the app and a path, so a demo is not tied to one host', () => {
    const read = readDemo(yaml());

    expect(read).toMatchObject({ ok: true, spec: { app: 'portal', path: '/#/playground' } });
  });

  it('reads numbers in a command as text, as the recorder does', () => {
    const read = readDemo(yaml());

    expect(read.ok && read.spec.steps[0]?.do?.[0]).toEqual([
      'wait',
      '--text',
      'Hva vil du prøve?',
      '--timeout',
      '30000',
    ]);
  });

  it('refuses a command outside the browser command allowlist', () => {
    const read = readDemo(
      yaml('  - say: Les en hemmelighet.\n    do:\n      - [eval, document.cookie]\n'),
    );

    expect(read.ok).toBe(false);
    expect(read.ok ? [] : read.errors.map((e) => e.path)).toEqual(['steps.1.do.0']);
  });

  it('refuses a field the demo format does not have', () => {
    expect(readDemo(`${yaml()}script: alert(1)\n`).ok).toBe(false);
  });

  it('refuses a start page on a host that is not one of the apps', () => {
    expect(readDemo(yaml().replace('portal.genki-test', 'example')).ok).toBe(false);
  });

  it('seeds a demo once, and again only when the file changes', async () => {
    const store = new InMemoryConfigEntryStore();

    const first = await seedDemos(store, [{ id: 'playground', spec: spec() }]);
    const again = await seedDemos(store, [{ id: 'playground', spec: spec() }]);
    const changed = await seedDemos(store, [{ id: 'playground', spec: spec('Ny tittel') }]);

    expect([first, again, changed].map((o) => o[0]?.state)).toEqual([
      'created',
      'present',
      'updated',
    ]);
    expect(await store.history(demoKind, platformScope, 'playground')).toHaveLength(2);
  });

  it('keeps a demo someone saved through the API instead of seeding over it', async () => {
    const store = new InMemoryConfigEntryStore();
    await store.append({
      kind: demoKind,
      scope: platformScope,
      id: 'playground',
      version: 1,
      spec: spec('Endret i konsollet'),
      deleted: false,
      by: 'operator:test:drift',
      at: '2026-11-17T10:00:00.000Z',
      reason: 'kortere fortelling',
    });

    const outcome = await seedDemos(store, [{ id: 'playground', spec: spec() }]);

    expect(outcome).toEqual([{ id: 'playground', state: 'kept' }]);
  });

  it('accepts only the recorder key whose digest is configured', () => {
    const digest = recorderKeyDigest('riktig-nøkkel');

    expect(isRecorderKey('riktig-nøkkel', digest)).toBe(true);
    expect(isRecorderKey('feil-nøkkel', digest)).toBe(false);
    expect(isRecorderKey('riktig-nøkkel', undefined)).toBe(false);
    expect(isRecorderKey(undefined, digest)).toBe(false);
  });

  it('counts the steps a recording has done by the screenshot taken after each step', () => {
    const file = (name: string) => ({ name, size: 1, contentType: 'image/png' });

    expect(stepsDone({ files: [] })).toBe(0);
    expect(
      stepsDone({ files: [file('step-1.png'), file('step-3.png'), file('failed-step-4.png')] }),
    ).toBe(3);
  });
});
