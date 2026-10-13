import { defineNamespace } from '@genai/i18n';

export const catalog = defineNamespace({
  title: 'Katalog',
  introTenant:
    'Virksomhetens egne endepunkter, modeller og datasett, ved siden av det plattformen deler med den. Hver endring blir en ny versjon.',
  introPlatform:
    'Endepunkter, modeller, datasett, rerankere og priser plattformen bruker. Hver endring blir en ny versjon og logges i Revisjon.',
  secretsNote: 'Hemmeligheter oppgis som referanse (for eksempel env:NAVN), aldri som verdi.',
  chooseTenant: 'Velg en virksomhet',
  loadingKinds: 'Henter hva virksomheten kan registrere',
  platformOnly:
    'Bare plattformen kan registrere {kind}. Bytt til plattformvisning for å se og endre dem.',
  tabModelEndpoint: 'Modellendepunkter',
  tabModel: 'Modeller',
  tabKnowledgeEndpoint: 'Kunnskapsendepunkter',
  tabDataset: 'Datasett',
  tabRerankEndpoint: 'Rerank-endepunkter',
  tabReranker: 'Rerankere',
  tabPrice: 'Priser',
});
