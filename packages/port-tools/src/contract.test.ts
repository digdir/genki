import { describeContract } from '@genai/plugins/testing';
import { builtinToolsContractTarget, toolSourceContract } from './contract.js';

describeContract('builtin', toolSourceContract, builtinToolsContractTarget);
