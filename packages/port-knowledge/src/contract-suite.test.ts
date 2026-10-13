import { describeContract } from '@genai/plugins/testing';
import { knowledgeContract, knowledgeContractSubject } from './contract-suite.js';
import { memoryEngine, seedCorpus } from './testing/index.js';

describeContract('memory', knowledgeContract, async () => {
  const engine = memoryEngine();
  const writer = engine.writer.connect(
    { options: {}, timeoutMs: 1000 },
    { signal: new AbortController().signal },
  );
  await seedCorpus(writer, { id: 'contract/runtime', filters: {}, options: {} });
  return { subject: knowledgeContractSubject({ adapter: engine.adapter, datasetOptions: {} }) };
});
