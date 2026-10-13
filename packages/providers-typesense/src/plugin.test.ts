import { describeContract } from '@genai/plugins/testing';
import { knowledgeContract } from '@genai/port-knowledge/contract';
import { typesenseContractTarget } from './plugin.js';

describeContract('typesense, read-only fake', knowledgeContract, typesenseContractTarget);
