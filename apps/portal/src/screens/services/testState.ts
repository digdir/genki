import { batchRows, type BatchSnapshot } from '../../data/services';
import type { ServiceDefinition } from '../../data/service-definition';
import { inputChoiceOn } from '../../data/service-form';
import { sharedInstructionsOf } from '../../data/service-languages';

export interface TestState {
  mode: 'single' | 'batch';
  batch: { ran: boolean; running: boolean; snap: BatchSnapshot };
  testset: boolean;
}

export const initialTestState = (d: ServiceDefinition): TestState => ({
  mode: 'batch',
  batch: {
    ran: true,
    running: false,
    snap: { ocr: false, example: false, model: d.spec.model.primary },
  },
  testset: false,
});

export const testKind = (id: string, d: ServiceDefinition) =>
  id === 'soknadsuttrekk'
    ? 'fields'
    : d.spec.output.kind === 'answer' &&
        inputChoiceOn(d.spec, 'text') &&
        (id === 'rapportassistenten' || sharedInstructionsOf(d.spec))
      ? 'chat'
      : 'empty';

export const scoreText = (snap: BatchSnapshot) => {
  const ok = batchRows(snap).filter((r) => r.ok).length;
  return `${ok} av 10 (${ok * 10} %)`;
};
