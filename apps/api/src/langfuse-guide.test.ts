import { datasetName } from '@genai/providers-langfuse';
import { describe, expect, it } from 'vitest';
import { testRunEnvironment } from './trace-datasets.js';

/** The portal's guide on the Langfuse connection screen, in one language, as one text. */
const guideIn = async (language: 'nb' | 'en') => {
  // A path the compiler does not follow: the portal's catalogues are built by the portal, not here.
  const file = new URL(`../../portal/src/i18n/${language}/operate-integrations.ts`, import.meta.url)
    .href;
  const catalogue = (await import(file)) as {
    integrationsArea: { integLangfuse: Record<string, string> };
  };
  return Object.entries(catalogue.integrationsArea.integLangfuse)
    .filter(([key]) => key.startsWith('guide'))
    .map(([, text]) => text)
    .join('\n');
};

describe("the portal's Langfuse guide", () => {
  it.each([
    ['nb', '<tjeneste-id>', '<testsett-id>'],
    ['en', '<service-id>', '<test-set-id>'],
  ] as const)(
    "names the dataset pattern, the root-span filter and the live-judge environment genki uses in both languages of the portal's Langfuse guide (%s)",
    async (language, service, testSet) => {
      const guide = await guideIn(language);

      expect(guide).toContain(`datasetId any of [${datasetName(service, testSet)}]`);
      expect(guide).toContain('isExperimentItemRootSpan = true');
      expect(guide).toContain(`environment none of [${testRunEnvironment}]`);
    },
  );
});
