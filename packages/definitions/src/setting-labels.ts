import type { SchemaLabels } from '@genai/contracts';

export const settingSchemaLabels: SchemaLabels = {
  nb: {
    'planner.enabled': {
      label: 'Planlegg søket',
      help: 'Lag søkefraser fra spørsmålet før det søkes.',
    },
    'planner.expansionMode': {
      label: 'Måte å utvide spørsmålet på',
      help: 'Hvordan spørsmålet gjøres om til søkefraser.',
    },
    'planner.maxPhrases': {
      label: 'Flest søkefraser',
      help: 'Tomt bruker standarden til planleggeren.',
    },
    'planner.prompt': {
      label: 'Ledetekst for planleggeren',
      help: 'Eget oppdrag til planleggeren. Tomt bruker det innebygde.',
    },
    'retrieval.retrieveTopK': {
      label: 'Treff som hentes (top-k)',
      help: 'Tekstbiter som hentes etter fletting, før vekting og omrangering.',
    },
    'retrieval.maxPerDocument': {
      label: 'Flest treff per dokument',
      help: 'Hvor mange tekstbiter ett dokument kan bidra med.',
    },
    'retrieval.queryAwareBoost': {
      label: 'Løft treff som ligner spørsmålet',
      help: 'Løfter treff som overlapper med spørsmålet.',
    },
    'retrieval.autoFilter.enabled': {
      label: 'Automatisk filter',
      help: 'Legg til filter ut fra virksomhets- og årstall-navn i spørsmålet.',
    },
    'retrieval.autoFilter.rules': {
      label: 'Regler for automatisk filter',
      help: 'Reglene for automatisk filtrering, i rekkefølge.',
    },
    'retrieval.docTitle.fanout': {
      label: 'Tekstbiter per titteltreff',
      help: 'Antall utdrag som leses per dokument som treffer på tittel.',
    },
    'retrieval.merge.mode': {
      label: 'Måte å flette søkene på',
      help: 'Hvordan resultatene fra søkestrategiene slås sammen.',
    },
    'retrieval.merge.rrfK': {
      label: 'Utjevning ved fletting (RRF k)',
      help: 'Glattingskonstanten når resultatene slås sammen med rangfusjon.',
    },
    'retrieval.merge.weights': {
      label: 'Vekt per søkemåte',
      help: 'Vekt per søkestrategi i sammenslåingen. Tomt bruker de innebygde vektene.',
    },
    'retrieval.merge.caps': {
      label: 'Tak per søkemåte',
      help: 'Flest treff én søkestrategi kan bidra med.',
    },
    'retrieval.userIntentUnion.enabled': {
      label: 'Søk også på brukerens hensikt',
      help: 'Slår på at treff fra brukerens intensjon blandes inn i resultatet.',
    },
    'retrieval.userIntentUnion.mode': {
      label: 'Måte å flette inn hensikten på',
      help: 'Hvordan treffene fra brukerens intensjon blandes inn.',
    },
    'retrieval.userIntentUnion.cap': {
      label: 'Plasser sikret for hensikten',
      help: 'Hvor mange utdrag fra brukerens intensjon som er sikret plass i modusen med tak.',
    },
    'retrieval.userIntentUnion.rrfK': {
      label: 'Utjevning for hensikten (RRF k)',
      help: 'Glattingskonstanten når treffene fra brukerens intensjon fusjoneres.',
    },
    'retrieval.rerank.enabled': {
      label: 'Omranger treffene',
      help: 'Ranger treffene på nytt med omrangeringsmodellen.',
    },
    'retrieval.rerank.candidateK': {
      label: 'Treff som omrangeres',
      help: 'Antall kandidater som sendes til omrangeringen.',
    },
    'retrieval.rerank.maxChunkLength': {
      label: 'Lengste tekst til omrangering',
      help: 'I tegn per tekstbit.',
    },
    'rag.topK': {
      label: 'Treff når den bare søker',
      help: 'Tomt bruker standarden til arbeidsmåten.',
    },
    'synthesis.contextTopK': {
      label: 'Kontekstvindu etter omrangering',
      help: 'Tekstbiter som tas med som grunnlag for svaret.',
    },
    'synthesis.maxDocs': {
      label: 'Flest dokumenter i svaret',
      help: 'Tomt betyr ingen grense.',
    },
    'synthesis.maxTokens': {
      label: 'Lengste svar (tokens)',
      help: 'Tomt bruker standarden til modellen.',
    },
    'synthesis.generationPrompt': {
      label: 'Ledetekst for svaret',
      help: 'Eget oppdrag for å skrive svaret. Tomt bruker det innebygde.',
    },
    'synthesis.instructions': {
      label: 'Systemledetekst for svaret',
      help: 'Egen systeminstruks til svarmodellen. Tomt bruker den innebygde.',
    },
    'synthesis.temperature': {
      label: 'Temperatur for svaret',
      help: 'Tomt bruker standarden til arbeidsmåten.',
    },
    'knowledge.switchRetentionDays': {
      label: 'Dager forrige søkemotor beholdes',
      help: 'Dager den forrige kopien i søkemotoren beholdes etter at et datasett bytter motor.',
    },
    'assistant.enabled': {
      label: 'Byggeassistenten er på',
      help: 'Tilby byggeassistenten i tjenestebyggeren.',
    },
    'assistant.dailyTokens': {
      label: 'Tokens per dag for assistenten',
      help: 'Nullstilles kl. 00.00 norsk tid.',
    },
    'assistant.model': {
      label: 'Modell for byggeassistenten',
      help: 'Modellen byggeassistenten bruker. Tomt velger første aktive modell med verktøy innenfor lovlig datalagring.',
    },
    'services.defaultModel': {
      label: 'Modell nye tjenester starter med',
      help: 'Modellen nye tjenester starter med. Tomt velger den billigste prisede modellen virksomheten kan bruke.',
    },
    'answers.writtenStandard': {
      label: 'Målform i svar',
      help: 'Svar på samme målform som spørsmålet, eller alltid bokmål eller nynorsk.',
    },
    'answers.languageInstructions.nb': {
      label: 'Husstil for svar på bokmål',
      help: 'Legges til etter instruksjonene til tjenesten når svaret er på bokmål. Virksomheten kan overstyre teksten fra Digdir.',
    },
    'answers.languageInstructions.nn': {
      label: 'Husstil for svar på nynorsk',
      help: 'Legges til etter instruksjonene til tjenesten når svaret er på nynorsk. Virksomheten kan overstyre teksten fra Digdir.',
    },
    'answers.languageInstructions.en': {
      label: 'Husstil for svar på engelsk',
      help: 'Legges til etter instruksjonene til tjenesten når svaret er på engelsk. Virksomheten kan overstyre teksten fra Digdir.',
    },
    'skills.defaultPassThreshold': {
      label: 'Krav for publisering av ferdigheter',
      help: 'Andel testtilfeller som må bestå når testsettet ikke har eget krav.',
    },
    'skills.testModel': {
      label: 'Modell for testkjøring av ferdigheter',
      help: 'Modellen som kjører testsett for ferdigheter. Tomt velger den billigste modellen virksomheten kan bruke.',
    },
    'skills.judgeModel': {
      label: 'Modell som vurderer testsvar',
      help: 'Modellen som vurderer svarene i testsettene. Tomt velger den billigste modellen fra en annen familie.',
    },
    'playground.enabled': {
      label: 'Prøveområdet er på',
      help: 'Tilby prøveområdet for å prøve tjenester, ferdigheter og byggeklosser.',
    },
    'usage.monthlyTokens': {
      label: 'Tokens per måned',
      help: 'Tokens en virksomhet kan bruke per kalendermåned. Prøveområdet nekter kjøringer når de er brukt opp.',
    },
    'batch.approvalLimitNok': {
      label: 'Grense per samlet jobb før godkjenning (kr)',
      help: 'Kroner en gruppekjøring kan anslås å koste før noen med tjenesterett må godkjenne den med begrunnelse. 0 slår godkjenning av.',
    },
    'retention.class': {
      label: 'Hvor lenge innhold beholdes',
      help: 'Hvor lenge spørsmål, svar og dokumenter beholdes etter at en kjøring er ferdig. Tjenester med høy risiko beholder dem minst 183 dager, begrenset risiko minst 30.',
    },
    'retention.auditDays': {
      label: 'Dager revisjonsspor beholdes',
      help: 'Dager revisjonssporet for en kjøring (id-er, type, hvem, forbruk, versjoner og tidspunkter) beholdes etter at den er ferdig. Aldri kortere enn innholdet.',
    },
    'usage.tenantCallsPerMinute': {
      label: 'Kall per minutt for virksomheten',
      help: 'Kall per minutt en virksomhet kan gjøre med alle nøkler og personer til sammen.',
    },
  },
  en: {
    'planner.enabled': {
      label: 'Plan the search',
      help: 'Create search phrases from the question before searching.',
    },
    'planner.expansionMode': {
      label: 'How the question is expanded',
      help: 'How the question is turned into search phrases.',
    },
    'planner.maxPhrases': {
      label: 'Most search phrases',
      help: 'Empty uses the planner default.',
    },
    'planner.prompt': {
      label: 'Prompt for the planner',
      help: 'A custom prompt for the planner. Empty uses the built-in one.',
    },
    'retrieval.retrieveTopK': {
      label: 'Results retrieved (top-k)',
      help: 'Text chunks retrieved after merging, before weighting and reranking.',
    },
    'retrieval.maxPerDocument': {
      label: 'Most results per document',
      help: 'How many text chunks one document can contribute.',
    },
    'retrieval.queryAwareBoost': {
      label: 'Boost results that resemble the question',
      help: 'Boosts hits that overlap with the question.',
    },
    'retrieval.autoFilter.enabled': {
      label: 'Automatic filter',
      help: 'Add filters based on organisation names and years in the question.',
    },
    'retrieval.autoFilter.rules': {
      label: 'Rules for the automatic filter',
      help: 'The rules for automatic filtering, in order.',
    },
    'retrieval.docTitle.fanout': {
      label: 'Text chunks per title match',
      help: 'Number of passages read per document that matches on title.',
    },
    'retrieval.merge.mode': {
      label: 'How the searches are merged',
      help: 'How the results from the search strategies are merged.',
    },
    'retrieval.merge.rrfK': {
      label: 'Smoothing when merging (RRF k)',
      help: 'The smoothing constant when results are merged with rank fusion.',
    },
    'retrieval.merge.weights': {
      label: 'Weight per search method',
      help: 'Weight per search strategy in the merge. Empty uses the built-in weights.',
    },
    'retrieval.merge.caps': {
      label: 'Cap per search method',
      help: 'The most hits one search strategy may contribute.',
    },
    'retrieval.userIntentUnion.enabled': {
      label: "Also search on the user's intent",
      help: 'Turns on mixing hits from the user intent into the result.',
    },
    'retrieval.userIntentUnion.mode': {
      label: 'How the intent is merged in',
      help: 'How the hits from the user intent are mixed in.',
    },
    'retrieval.userIntentUnion.cap': {
      label: 'Places reserved for the intent',
      help: 'How many passages from the user intent are guaranteed a place in cap mode.',
    },
    'retrieval.userIntentUnion.rrfK': {
      label: 'Smoothing for the intent (RRF k)',
      help: 'The smoothing constant when the hits from the user intent are fused.',
    },
    'retrieval.rerank.enabled': {
      label: 'Rerank the results',
      help: 'Rank the results again with the reranking model.',
    },
    'retrieval.rerank.candidateK': {
      label: 'Results that are reranked',
      help: 'Number of candidates sent to the reranker.',
    },
    'retrieval.rerank.maxChunkLength': {
      label: 'Longest text for reranking',
      help: 'In characters per text chunk.',
    },
    'rag.topK': {
      label: 'Results when it only searches',
      help: 'Empty uses the default of the way of working.',
    },
    'synthesis.contextTopK': {
      label: 'Context window after reranking',
      help: 'Text chunks included as the basis for the answer.',
    },
    'synthesis.maxDocs': {
      label: 'Most documents in the answer',
      help: 'Empty means no limit.',
    },
    'synthesis.maxTokens': {
      label: 'Longest answer (tokens)',
      help: 'Empty uses the model default.',
    },
    'synthesis.generationPrompt': {
      label: 'Prompt for the answer',
      help: 'A custom prompt for writing the answer. Empty uses the built-in one.',
    },
    'synthesis.instructions': {
      label: 'System prompt for the answer',
      help: 'A custom system instruction for the answering model. Empty uses the built-in one.',
    },
    'synthesis.temperature': {
      label: 'Temperature for the answer',
      help: 'Empty uses the default of the way of working.',
    },
    'knowledge.switchRetentionDays': {
      label: 'Days the previous search engine is kept',
      help: 'Days the previous search engine copy is kept after a dataset switches engine.',
    },
    'assistant.enabled': {
      label: 'The build assistant is on',
      help: 'Offer the build assistant in the service builder.',
    },
    'assistant.dailyTokens': {
      label: 'Tokens per day for the assistant',
      help: 'Reset at 00:00 Norwegian time.',
    },
    'assistant.model': {
      label: 'Model for the build assistant',
      help: 'The model the build assistant uses. Empty picks the first enabled model with tools within the allowed data location.',
    },
    'services.defaultModel': {
      label: 'Model new services start with',
      help: 'The model new services start with. Empty picks the cheapest priced model the organisation may use.',
    },
    'answers.writtenStandard': {
      label: 'Written standard in answers',
      help: 'Answer in the same written standard as the question, or always bokmål or nynorsk.',
    },
    'answers.languageInstructions.nb': {
      label: 'House style for answers in bokmål',
      help: 'Added after the service instructions when the answer is in bokmål. An organisation can override the text from Digdir.',
    },
    'answers.languageInstructions.nn': {
      label: 'House style for answers in nynorsk',
      help: 'Added after the service instructions when the answer is in nynorsk. An organisation can override the text from Digdir.',
    },
    'answers.languageInstructions.en': {
      label: 'House style for answers in English',
      help: 'Added after the service instructions when the answer is in English. An organisation can override the text from Digdir.',
    },
    'skills.defaultPassThreshold': {
      label: 'Requirement for publishing skills',
      help: 'Share of test cases that must pass when the test set has no requirement of its own.',
    },
    'skills.testModel': {
      label: 'Model for test runs of skills',
      help: 'The model that runs test sets for skills. Empty picks the cheapest model the organisation may use.',
    },
    'skills.judgeModel': {
      label: 'Model that judges test answers',
      help: 'The model that judges answers in the test sets. Empty picks the cheapest model from another family.',
    },
    'playground.enabled': {
      label: 'The playground is on',
      help: 'Offer the playground for trying services, skills and building blocks.',
    },
    'usage.monthlyTokens': {
      label: 'Tokens per month',
      help: 'Tokens an organisation may use per calendar month. The playground refuses runs once they are used up.',
    },
    'batch.approvalLimitNok': {
      label: 'Limit per batch job before approval (NOK)',
      help: 'Kroner a batch run may be estimated to cost before someone who manages services must approve it with a reason. 0 turns approval off.',
    },
    'retention.class': {
      label: 'How long content is kept',
      help: 'How long questions, answers and documents are kept after a run ends. High-risk services keep them at least 183 days, limited-risk at least 30.',
    },
    'retention.auditDays': {
      label: 'Days the audit trail is kept',
      help: 'Days the audit trail of a run (ids, type, who, usage, versions and times) is kept after it ends. Never shorter than the content.',
    },
    'usage.tenantCallsPerMinute': {
      label: 'Calls per minute for the organisation',
      help: 'Calls per minute an organisation may make across all its keys and people.',
    },
  },
  meta: {
    'planner.enabled': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'planner.expansionMode': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'planner.maxPhrases': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'planner.prompt': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.retrieveTopK': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.maxPerDocument': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.queryAwareBoost': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.autoFilter.enabled': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.autoFilter.rules': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.docTitle.fanout': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.merge.mode': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.merge.rrfK': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.merge.weights': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.merge.caps': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.userIntentUnion.enabled': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.userIntentUnion.mode': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.userIntentUnion.cap': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.userIntentUnion.rrfK': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.rerank.enabled': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.rerank.candidateK': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'retrieval.rerank.maxChunkLength': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'rag.topK': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'synthesis.contextTopK': {
      'x-group': {
        nb: 'Svar',
        en: 'Answers',
      },
    },
    'synthesis.maxDocs': {
      'x-group': {
        nb: 'Svar',
        en: 'Answers',
      },
    },
    'synthesis.maxTokens': {
      'x-group': {
        nb: 'Svar',
        en: 'Answers',
      },
    },
    'synthesis.generationPrompt': {
      'x-group': {
        nb: 'Svar',
        en: 'Answers',
      },
    },
    'synthesis.instructions': {
      'x-group': {
        nb: 'Svar',
        en: 'Answers',
      },
    },
    'synthesis.temperature': {
      'x-group': {
        nb: 'Svar',
        en: 'Answers',
      },
    },
    'knowledge.switchRetentionDays': {
      'x-group': {
        nb: 'Søk',
        en: 'Search',
      },
    },
    'assistant.enabled': {
      'x-group': {
        nb: 'Assistent',
        en: 'Assistant',
      },
    },
    'assistant.dailyTokens': {
      'x-group': {
        nb: 'Assistent',
        en: 'Assistant',
      },
    },
    'assistant.model': {
      'x-group': {
        nb: 'Assistent',
        en: 'Assistant',
      },
    },
    'services.defaultModel': {
      'x-group': {
        nb: 'Modeller',
        en: 'Models',
      },
    },
    'answers.writtenStandard': {
      'x-group': {
        nb: 'Svar',
        en: 'Answers',
      },
    },
    'answers.languageInstructions.nb': {
      'x-group': {
        nb: 'Svar',
        en: 'Answers',
      },
    },
    'answers.languageInstructions.nn': {
      'x-group': {
        nb: 'Svar',
        en: 'Answers',
      },
    },
    'answers.languageInstructions.en': {
      'x-group': {
        nb: 'Svar',
        en: 'Answers',
      },
    },
    'skills.defaultPassThreshold': {
      'x-group': {
        nb: 'Ferdigheter',
        en: 'Skills',
      },
    },
    'skills.testModel': {
      'x-group': {
        nb: 'Ferdigheter',
        en: 'Skills',
      },
    },
    'skills.judgeModel': {
      'x-group': {
        nb: 'Ferdigheter',
        en: 'Skills',
      },
    },
    'playground.enabled': {
      'x-group': {
        nb: 'Prøveområde',
        en: 'Playground',
      },
    },
    'usage.monthlyTokens': {
      'x-group': {
        nb: 'Forbruk',
        en: 'Usage',
      },
    },
    'batch.approvalLimitNok': {
      'x-group': {
        nb: 'Forbruk',
        en: 'Usage',
      },
    },
    'retention.class': {
      'x-group': {
        nb: 'Oppbevaring',
        en: 'Retention',
      },
    },
    'retention.auditDays': {
      'x-group': {
        nb: 'Oppbevaring',
        en: 'Retention',
      },
    },
    'usage.tenantCallsPerMinute': {
      'x-group': {
        nb: 'Forbruk',
        en: 'Usage',
      },
    },
  },
};
