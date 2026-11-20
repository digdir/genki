import { fromTemplate } from '@genai/ui-blocks/builder';
import { describe, expect, it } from 'vitest';
import type { TriedHere } from '../../components/playground/PlaygroundPanel';
import { serviceTemplate } from '../../mock';
import { serviceFromPlayground, type HandoverItem } from './handover';

const layout = fromTemplate('knowledge-assistant-next').layout;

const tried = (patch: Partial<TriedHere> = {}): TriedHere => ({
  setup: { model: 'aivar/qwen3-8', datasets: [], skills: [], blocks: [], output: 'text' },
  instructions: 'Svar kort.',
  residency: 'norway',
  addedBlocks: false,
  answerLanguage: false,
  compare: false,
  conversation: false,
  ...patch,
});

const make = (from: TriedHere | undefined) =>
  serviceFromPlayground({
    template: serviceTemplate('999888777'),
    tenant: '999888777',
    name: 'Ny tjeneste fra prøveområdet',
    layout,
    tried: from,
  });

const specOf = (made: ReturnType<typeof make>) =>
  made.definition.spec as {
    model: { primary: string; residency: string };
    interface: { layout: unknown };
  };

describe('a service made from the playground', () => {
  it('keeps the layout tried in Frontend in spec.interface.layout', () => {
    expect(specOf(make(undefined)).interface.layout).toEqual(layout);
  });

  it('leaves nothing out when only the model, instructions and datasets were tried', () => {
    expect(make(tried()).handover.left).toEqual([]);
  });

  it('allows the residency of the tried model, so the model may run in the new service', () => {
    const spec = specOf(
      make(
        tried({ setup: { ...tried().setup, model: 'foundry-openai/gpt-4.1' }, residency: 'eu' }),
      ),
    );
    expect(spec.model).toEqual({ primary: 'foundry-openai/gpt-4.1', residency: 'eu' });
  });

  it('lists the instructions as not carried while those of the started service are still loading', () => {
    const made = make(tried({ instructions: undefined }));
    expect(made.handover.carried).not.toContain('instructions');
    expect(made.handover.left).toEqual(['instructions']);
  });

  it.each<[HandoverItem, Partial<TriedHere>]>([
    ['skills', { setup: { ...tried().setup, skills: ['skrive-vedtaksbrev'] } }],
    ['blocks', { addedBlocks: true }],
    ['output', { setup: { ...tried().setup, output: 'fields' } }],
    [
      'startService',
      { setup: { ...tried().setup, service: { id: 'rapportassistenten', version: 7 } } },
    ],
    ['answerLanguage', { answerLanguage: true }],
    ['compare', { compare: true }],
    ['conversation', { conversation: true }],
  ])('lists %s as tried and not carried over', (item, patch) => {
    expect(make(tried(patch)).handover.left).toEqual([item]);
  });
});
