import { describeContract } from '@genai/plugins/testing';
import { embeddingContract, embeddingContractTarget } from '@genai/port-embedding/contract';
import { modelContract, modelContractTarget } from '@genai/port-model/contract';
import { openAiChatFixture, openAiResponsesFixture, openAiEmbeddingsFixture } from './contract.js';

describeContract('openai-chat', modelContract, () => modelContractTarget(openAiChatFixture));

describeContract('openai-embeddings', embeddingContract, () =>
  embeddingContractTarget(openAiEmbeddingsFixture),
);

describeContract('openai Responses', modelContract, () =>
  modelContractTarget(openAiResponsesFixture),
);
