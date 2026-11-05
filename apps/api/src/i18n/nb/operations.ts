import { defineNamespace } from '@genai/i18n';

export const operations = defineNamespace({
  minutes: '{minutes} min',
  hours: '{hours} t',
  hoursMinutes: '{hours} t {minutes} min',
  database: 'Database',
  databaseAnswered: 'Svarte på {ms} ms.',
  databaseDown: 'Svarer ikke.',
  models: 'Modeller: {endpoint}',
  modelsInUse: '{enabled} av {total} modeller i bruk.',
  runs: 'Kjøringer',
  ingestion: 'Innlesing',
  ingestionUnavailable: 'Innlesing er ikke tilgjengelig.',
  scheduledIngestion: 'Planlagt innlesing: {pipeline} · {dataset}',
  ingestionFailed: 'Innlesingen feilet.',
  runningIngestions: 'Innlesinger som kjører',
  failedIngestions: 'Innlesinger som feilet siste døgn',
  activeRuns: 'Kjøringer som pågår',
  longestIngestion: 'Lengst kjørende innlesing',
  switchChooseEngine: 'velg en søkemotor',
  switchUnknownEngine: 'ukjent søkemotor {to}',
  switchSameEngine: 'Datasettet bruker allerede denne søkemotoren.',
  switchWriteKeyRequired: 'Krever egen skrivenøkkel',
  switchCannotWrite: 'Plattformen kan ikke skrive til denne søkemotoren.',
  switchSharedStorage: 'Søkemotorene deler lagring. Velg en annen søkemotor.',
  switchMissingModel: 'Vektormodellen {model} er ikke satt opp på plattformen.',
  switchCopyNeedsSameModel:
    'Kopiering krever samme vektormodell. Nå brukes {current}, den nye søkemotoren bruker {wanted}. Les inn på nytt fra kilden.',
  switchCannotRead: 'Plattformen kan ikke lese dokumentene fra den nåværende søkemotoren.',
  switchNoPipeline: 'Datasettet har ingen innlesing å kjøre.',
  switchBusy: 'Et bytte pågår allerede ({id}).',
  switchStalled: 'Overføringen stoppet. Start den på nytt.',
  switchKnowledgeCopyExport:
    'Søkemotoren til datasettet kan ikke gi fra seg dokumentene ett og ett, så de kan ikke kopieres til kunnskapsdatabasen. Les inn på nytt fra kilden.',
  switchKnowledgeNeedsModel: 'Velg en embeddingmodell: datasettet har ingen.',
  switchCopySubset:
    'Dette byttet kopierte bare et utvalg dokumenter, så det kan ikke tas i bruk. Start en kopi av hele datasettet.',
  switchCopyDocuments:
    'documents er en liste med 1 til 1000 dokument-id-er, bare for en kopi til kunnskapsdatabasen.',
  switchKnowledgeOnePipeline:
    'Et datasett i kunnskapsdatabasen fylles av én innlesing til medeiere er bygget; dette har {pipelines}.',
  switchKnowledgePhrases:
    'Søkefraser kan ikke fylle et datasett i kunnskapsdatabasen før oppskriftene holder dem ({pipeline}).',
  switchRunCancelled: 'Kjøringen {run} ble avbrutt.',
});
