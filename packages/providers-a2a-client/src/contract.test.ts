import { describeContract } from '@genai/plugins/testing';
import { toolSourceContract } from '@genai/port-tools/contract';
import { a2aToolsContractTarget } from './contract.js';

describeContract('a2a', toolSourceContract, a2aToolsContractTarget);
