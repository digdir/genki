import { defineNamespace } from '@genai/i18n';

export const platformBlocks = defineNamespace({
  flowAgentRagName: 'Agentisk RAG',
  flowAgentRagDescription: 'Allsidig agent som søker, leser og svarer ut fra dokumentene',
  flowAiOverviewName: 'KI-oversikt',
  flowAiOverviewDescription:
    'Kort, samlet svar med kildehenvisninger i teksten, foran selve søkeresultatene. Avstår heller enn å svare når søket gir for lite å bygge på.',
  flowAltinnDocsTunedName: 'Altinn-dokumentasjon, tilpasset',
  flowAltinnDocsTunedDescription:
    'Søk tilpasset Altinn-dokumentasjonen, med bare frasevekting og grenser per strategi. Et alternativ du velger selv i stedet for den generelle agenten.',
  flowBasicRagName: 'Enkel RAG',
  flowBasicRagDescription:
    'Planlegger spørringer, søker, rangerer på nytt og svarer fra nummererte kilder med kildehenvisninger',
  flowDocsOutlineName: 'Disposisjon for dokumentasjon',
  flowDocsOutlineDescription:
    'Foreslår en strukturert disposisjon for en ny dokumentasjonsside ut fra dokumentasjonen den skal bygge på',
  flowDocsReleaseCrossCheckName: 'Kryssjekk av utgivelsesnotater',
  flowDocsReleaseCrossCheckDescription:
    'Gjør utgivelsesnotater om til en gjøremålsliste per side med endringer i dokumentasjonen, med henvisning til sidene som trenger dem',
  flowEntityExtractionName: 'Uttrekk av enheter',
  flowEntityExtractionDescription:
    'Trekker ut strukturerte enheter (personer, organisasjoner, datoer, steder og mer) fra tekst',
  flowFactCheckerName: 'Faktasjekk',
  flowFactCheckerDescription: 'Kontrollerer påstander mot dokumentasjon',
  flowMultiQueryRagName: 'RAG med flere spørringer',
  flowMultiQueryRagDescription:
    'Planlegger flere søkespørringer, søker på alle, slår sammen, rangerer på nytt og svarer med kildehenvisninger',
  flowMultiRetrievalName: 'Søk med flere spørringer',
  flowMultiRetrievalDescription: 'Søker med flere spørringer og slår sammen resultatene',
  flowResearchAssistantName: 'Forskningsassistent',
  flowResearchAssistantDescription:
    'Bredt søk og et svar som i hovedsak er en sammenstilling, for spørsmål som trenger en oversikt over kildene mer enn ett enkelt faktum',
  flowRetrieveAndRerankName: 'Søk og ny rangering',
  flowRetrieveAndRerankDescription:
    'Søker på spørsmålet slik det står og rangerer på nytt, uten planlegging og uten å lage et svar',
  flowSummarizationName: 'Oppsummering',
  flowSummarizationDescription: 'Lager et sammendrag av innholdet som er gitt',

  blockModelName: 'Spør språkmodellen',
  blockModelDescription: 'Ett kall til språkmodellen med en ledetekst. Kan strømme svaret.',
  blockExtractName: 'Hent ut opplysninger',
  blockExtractDescription:
    'Modellen fyller ut et skjema. Med tekstbiter som grunnlag får hver verdi kilden sin.',
  blockClassifyName: 'Klassifiser',
  blockClassifyDescription: 'Velger nøyaktig én kategori for en tekst.',
  blockRetrieveName: 'Søk',
  blockRetrieveDescription: 'Planlegger søk og henter tekstbiter fra datasettene til tjenesten.',
  blockRerankName: 'Ranger treff',
  blockRerankDescription: 'Rangerer tekstbitene og setter sammen grunnlaget modellen leser.',
  blockSynthesizeName: 'Skriv svar fra grunnlaget',
  blockSynthesizeDescription: 'Skriver et svar med kildehenvisninger fra grunnlaget.',
  blockEvidenceGateName: 'Sjekk om grunnlaget holder',
  blockEvidenceGateDescription: 'Avgjør om det er nok gode kilder til å svare.',
  blockOverviewFinalizeName: 'Fullfør oversikten',
  blockOverviewFinalizeDescription:
    'Avslutter en oversikt, eller avslår når grunnlaget ikke holder.',
  blockAnswerName: 'Lever svar med kilder',
  blockAnswerDescription: 'Setter sammen svaret og kildelisten som tjenesten leverer.',
  blockTemplateName: 'Sett sammen tekst',
  blockTemplateDescription: 'Setter sammen tekst med verdier fra stegene før.',
  blockRouteName: 'Send til kø',
  blockRouteDescription: 'Noterer hvilken kø saken skal til.',
  blockApprovalName: 'Spør et menneske',
  blockApprovalDescription: 'Stopper flyten til en person har svart, og fortsetter med svaret.',
  blockAgentName: 'La modellen søke selv',
  blockAgentDescription: 'Lar modellen søke, lese og svare selv, som ett steg i flyten.',
  blockFacetsName: 'Hent fasettverdier',
  blockFacetsDescription:
    'Henter avgrensede fasettverdier og antall fra tjenestens datasett til senere steg.',
  blockDocumentsName: 'Finn dokumenter',
  blockDocumentsDescription:
    'Lister dokumenter fra datasettene til tjenesten etter type, virksomhet, år eller id. Lager ingen tekst.',
  blockReadDocumentName: 'Les ett dokument',
  blockReadDocumentDescription:
    'Henter tekstbitene i ett dokument, og kan rangere dem etter et spørsmål og beholde de beste.',
  blockTableName: 'Lag tabell med kilder',
  blockTableDescription:
    'Setter sammen resultatene fra en løkke til en tabell der hver celle har kilden sin. Kan lastes ned som CSV.',
  blockToolName: 'Kall et verktøy',
  blockToolDescription:
    'Kaller ett verktøy fra en registrert verktøykilde med verdier fra flyten, og gir resultatet videre til stegene etter.',
});
