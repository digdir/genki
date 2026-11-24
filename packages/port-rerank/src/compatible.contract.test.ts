import { loadDescriptors } from '@genai/operations';
import { describeContract } from '@genai/plugins/testing';
import { compatibleRerankFixture, rerankContract, rerankContractTarget } from './contract.js';

describeContract('compatible/rerank@1', rerankContract, () =>
  rerankContractTarget(compatibleRerankFixture(loadDescriptors())),
);
