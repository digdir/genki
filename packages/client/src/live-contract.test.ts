import { describe, it } from 'vitest';
import { describeContract } from '@genai/plugins/testing';
import { createClient } from './client.js';
import { frontendContract } from './contract-suite.js';
import type { FilterSet } from './types.js';

const env = process.env;
const baseUrl = env.GENAI_CONTRACT_URL;
const service = env.GENAI_CONTRACT_SERVICE;

if (baseUrl && service) {
  const connect = (apiKey?: string) =>
    createClient({
      baseUrl,
      ...(apiKey ? { apiKey, userId: env.GENAI_CONTRACT_USER ?? 'contract-test' } : {}),
    });
  const [tenant, key, id, field] = (env.GENAI_CONTRACT_DATASET ?? '').split(',');
  describeContract('live platform', frontendContract, async () => ({
    subject: {
      client: connect(env.GENAI_CONTRACT_KEY),
      anonymous: connect(),
      service,
      question: env.GENAI_CONTRACT_QUESTION ?? 'Hva kan du hjelpe med?',
      ...(tenant && key && id && field ? { dataset: { tenant, key, id, field } } : {}),
      ...(env.GENAI_CONTRACT_FILTER
        ? { filter: JSON.parse(env.GENAI_CONTRACT_FILTER) as FilterSet }
        : {}),
      feedback: env.GENAI_CONTRACT_FEEDBACK === 'true',
    },
  }));
} else {
  describe.skip('frontend contract against a live platform', () => {
    it('runs when GENAI_CONTRACT_URL and GENAI_CONTRACT_SERVICE are set', () => undefined);
  });
}
