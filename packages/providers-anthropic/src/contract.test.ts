import { describeContract } from '@genai/plugins/testing';
import { modelContract, modelContractTarget } from '@genai/port-model/contract';
import { anthropicMessagesFixture } from './contract.js';

describeContract('anthropic-messages', modelContract, () =>
  modelContractTarget(anthropicMessagesFixture),
);
