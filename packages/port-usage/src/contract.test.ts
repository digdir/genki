import { describeContract } from '@genai/plugins/testing';
import { memoryUsageContractTarget, usageContract } from './contract.js';

describeContract('memory', usageContract, memoryUsageContractTarget);
