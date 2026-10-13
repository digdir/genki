import { describe, expect, it } from 'vitest';
import { exampleFlows, type Flow } from '../../data/stepflows';
import { withCatalogText } from './LiveWorkspace';

const flow: Flow = {
  ...(exampleFlows[0] as Flow),
  id: 'basic-rag',
  name: 'Basic RAG',
  desc: 'Plans queries, searches and answers',
  usedBy: [],
};

describe('withCatalogText', () => {
  it('shows the localized name, description and users the building block catalogue gives a flow', () => {
    const shown = withCatalogText(flow, [
      {
        id: 'basic-rag',
        kind: 'step_flow',
        name: 'Enkel RAG',
        description: 'Planlegger spørringer, søker og svarer',
        usedBy: [{ id: 'ka', name: 'Kunnskapsassistenten' }],
      },
    ]);
    expect(shown).toMatchObject({
      name: 'Enkel RAG',
      desc: 'Planlegger spørringer, søker og svarer',
      usedBy: ['Kunnskapsassistenten'],
    });
  });

  it('keeps the definition text when the catalogue does not know the flow', () => {
    expect(withCatalogText(flow, [])).toBe(flow);
  });
});
