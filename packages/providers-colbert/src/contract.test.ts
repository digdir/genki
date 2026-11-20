import { describeContract } from '@genai/plugins/testing';
import { rerankContract, rerankContractTarget } from '@genai/port-rerank/contract';
import { colbertFixture } from './contract.js';

describeContract('colbert', rerankContract, () => rerankContractTarget(colbertFixture));
