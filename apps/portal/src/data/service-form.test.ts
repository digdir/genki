import { beforeEach, describe, expect, it } from 'vitest';
import { platformStrategies } from '../mock/strategies';
import { applySpec, type ServiceDefinition, type SpecEdit } from './service-definition';
import {
  channelOn,
  examplesOf,
  withChannel,
  withExamples,
  withGuard,
  withInputChoice,
  withOutputKind,
  withPublicCard,
  withRisk,
  withStrategy,
  withTrigger,
} from './service-form';
import { exampleTemplate } from './services';
import { registerStrategies } from './strategies';

beforeEach(() => registerStrategies(platformStrategies));

const service = (): ServiceDefinition => exampleTemplate('rewrites', 'Post');
const edit = (d: ServiceDefinition, ...edits: SpecEdit[]) =>
  edits.reduce((cur, e) => applySpec(cur, e), d);

describe('editing a service definition in the portal', () => {
  it('keeps every field the form does not know about', () => {
    const d = applySpec(service(), {
      variants: [{ id: 'default', aliases: ['ka', { name: 'ka-chat' }] }],
      callOverrides: { openai: ['temperature'] },
      exampleQuestions: ['Hva er klarspråk?'],
    });

    const after = edit(d, { purpose: 'Skriver om brev' }, (cur) =>
      withGuard(cur.spec, 'require-sources', true),
    );

    expect(after.spec.variants).toEqual(d.spec.variants);
    expect(after.spec.callOverrides).toEqual({ openai: ['temperature'] });
    expect(after.spec.exampleQuestions).toEqual(['Hva er klarspråk?']);
  });

  it('writes triggers with their defaults and keeps a published schedule', () => {
    const d = edit(
      service(),
      (cur) => withChannel(cur.spec, 'fileTrigger', true),
      (cur) => withChannel(cur.spec, 'queue', true),
      (cur) => withTrigger(cur.spec, { kind: 'queue-message', queue: 'post-inn' }),
      { triggers: [{ kind: 'schedule', cron: '15 5 * * 1-5' }] },
      (cur) => withChannel(cur.spec, 'fileTrigger', true),
    );

    expect(d.spec.triggers).toEqual([
      { kind: 'schedule', cron: '15 5 * * 1-5' },
      { kind: 'document-arrives', folder: 'Innboks' },
    ]);
    expect(channelOn(d.spec, 'schedule')).toBe(true);
    expect(channelOn(d.spec, 'queue')).toBe(false);
  });

  it('turns the public A2A card off with the A2A channel', () => {
    const on = edit(
      service(),
      (cur) => withChannel(cur.spec, 'a2a', true),
      (cur) => withPublicCard(cur.spec, true),
    );
    const off = edit(on, (cur) => withChannel(cur.spec, 'a2a', false));

    expect(on.spec.exposure).toMatchObject({ a2a: true, a2aPublicCard: true });
    expect(off.spec.exposure).toMatchObject({ a2a: false, a2aPublicCard: false });
  });

  it('adds and removes all MIME types of an input choice', () => {
    const d = edit(service(), (cur) => withInputChoice(cur.spec, 'files'));
    const back = edit(d, (cur) => withInputChoice(cur.spec, 'files'));

    expect(d.spec.input.accepts).toEqual([
      'text/plain',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
    expect(back.spec.input.accepts).toEqual(['text/plain']);
  });

  it('keeps the instructions and the examples when the new strategy takes them', () => {
    const d = edit(
      service(),
      (cur) => ({ strategy: { ...cur.spec.strategy, config: { instructions: 'Svar kort.' } } }),
      (cur) => withExamples(cur.spec, [{ input: 'a', output: 'b' }]),
    );

    const agent = edit(d, (cur) => withStrategy(cur.spec, 'agent-loop'));

    expect(examplesOf(d.spec)).toEqual([{ input: 'a', output: 'b' }]);
    expect(agent.spec.strategy).toEqual({
      id: 'agent-loop',
      version: 1,
      config: { maxIterations: 8, instructions: 'Svar kort.' },
    });
  });

  it('clears the risk confirmation when the risk changes, and sources when the output is not an answer', () => {
    const d = edit(
      service(),
      { riskConfirmation: { at: '2026-10-13', reasons: [], riskClass: 'limited' } },
      { output: { kind: 'answer', withSources: true } },
      withRisk('high'),
      (cur) => withOutputKind(cur.spec, 'document'),
    );

    expect(d.spec.riskClass).toBe('high');
    expect(d.spec.riskConfirmation).toBeUndefined();
    expect(d.spec.output).toEqual({ kind: 'document', withSources: false });
  });
});
