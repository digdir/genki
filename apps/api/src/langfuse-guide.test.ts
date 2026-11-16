import { datasetName } from '@genai/providers-langfuse';
import { describe, expect, it } from 'vitest';
import { testRunEnvironment } from './trace-datasets.js';

/** The portal's guide on the Langfuse connection screen, in one language, by key. */
const guideIn = async (language: 'nb' | 'en') => {
  // A path the compiler does not follow: the portal's catalogues are built by the portal, not here.
  const file = new URL(`../../portal/src/i18n/${language}/operate-integrations.ts`, import.meta.url)
    .href;
  const catalogue = (await import(file)) as {
    integrationsArea: { integLangfuse: Record<string, string> };
  };
  return catalogue.integrationsArea.integLangfuse;
};

describe("the portal's Langfuse guide", () => {
  it.each([
    ['nb', '<tjeneste-id>', '<testsett-id>'],
    ['en', '<service-id>', '<test-set-id>'],
  ] as const)(
    "names the dataset pattern, the root-span filter and the live-judge environment genki uses in both languages of the portal's Langfuse guide (%s)",
    async (language, service, testSet) => {
      const guide = await guideIn(language);
      const dataset = datasetName(service, testSet);

      expect(guide.guideJudge).toContain(dataset);
      expect(guide.guideJudge).toContain('isExperimentItemRootSpan = true');
      expect(guide.guideDatasetLangfuse).toContain(dataset);
      expect(guide.guideLive).toContain(`environment none of [${testRunEnvironment}]`);
      expect(guide.guideTraceLangfuse).toContain(testRunEnvironment);
    },
  );
});
