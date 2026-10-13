import { describeContract } from '@genai/plugins/testing';
import { toolSourceContract } from '@genai/port-tools/contract';
import { mcpToolsContractTarget } from './contract.js';

describeContract('mcp', toolSourceContract, mcpToolsContractTarget);
