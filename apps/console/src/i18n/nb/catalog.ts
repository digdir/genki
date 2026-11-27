import { defineNamespace } from '@genai/i18n';

export const catalog = defineNamespace({
  title: 'Endepunkter og priser',
  introTenant:
    'Virksomhetens egne endepunkter, modeller og dokumentsamlinger, ved siden av det plattformen deler med den. Hver endring blir en ny utgave.',
  introPlatform:
    'Endepunkter, modeller, dokumentsamlinger og priser plattformen bruker. Hver endring blir en ny utgave og logges.',
  secretsNote: 'Hemmeligheter oppgis som referanse (for eksempel env:NAVN), aldri som verdi.',
  chooseTenant: 'Velg en virksomhet',
  loadingKinds: 'Henter hva virksomheten kan registrere',
  platformOnly:
    'Bare plattformen kan registrere {kind}. Bytt til plattformvisning for å se og endre dem.',
  tabModelEndpoint: 'Modellendepunkter',
  tabModel: 'Modeller',
  tabKnowledgeEndpoint: 'Kunnskapsendepunkter',
  tabDataset: 'Dokumentsamlinger',
  tabPrice: 'Priser',
});
