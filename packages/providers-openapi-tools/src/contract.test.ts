import { describeContract } from '@genai/plugins/testing';
import { toolSourceContract } from '@genai/port-tools/contract';
import { openApiToolsContractTarget } from './contract.js';

describeContract('openapi', toolSourceContract, openApiToolsContractTarget);
