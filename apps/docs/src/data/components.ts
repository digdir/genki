import type { Status } from './blocks';

export type ComponentStatus = Status | 'planlagt';

/**
 * Neste nivå under en byggekloss: de konfigurerbare delene et lag typisk består av.
 * `options` er typiske valg eller varianter, `practices` er anbefalt praksis.
 */
export type Component = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  capabilities: string[];
  options?: string[];
  practices?: string[];
  status: ComponentStatus;
};

export const componentsByBlock: Record<string, Component[]> = {
  /* ---------------------------------------------------------------- KI-porten (KI-gateway) */
  'ki-gateway': [
    {
      id: 'modellkatalog',
      name: 'Modellkatalog og virtuelle modellnavn',
      tagline: 'Ett API mot alle leverandører, modellen velges med navn',
      description:
        'Tjenestene snakker ett OpenAI-kompatibelt API. Gatewayen oversetter til leverandørens protokoll, enten modellen kjører hos en skyleverandør, hos Sigma2 eller i egen drift. Et virtuelt modellnavn som «norsk-standard» kan peke på en annen modell i morgen uten at tjenesten endres.',
      capabilities: [
        'OpenAI-kompatibelt API for chat, embeddings og responses',
        'Adaptere for OpenAI, Anthropic, Azure, Bedrock, Vertex og selvhostede modeller (vLLM)',
        'Virtuelle modellnavn frikoblet fra leverandør og versjon',
        'Katalog med kapabiliteter: streaming, verktøykall, JSON-skjema, resonnering, kontekstvindu',
        'Automatisk oppdagelse av deployments hos leverandøren',
      ],
      practices: [
        'Tjenester refererer alltid et virtuelt navn, aldri en leverandørmodell direkte',
        'Nye modeller inn i katalogen før de kan velges i en definisjon',
      ],
      status: 'delvis',
    },
    {
      id: 'ruting',
      name: 'Ruting og failover',
      tagline: 'Riktig modell, og en reserve når den feiler',
      description:
        'Rutingregler bestemmer hvilken modellinstans en forespørsel går til, basert på modellnavn, dataresidens, kostnad og kapasitet. Faller en leverandør ut, går trafikken til neste i listen, og tjenesten merker ingenting annet enn litt høyere latens.',
      capabilities: [
        'Regelbasert ruting på modell, residens, pris og header',
        'Fallback mellom leverandører og regioner med retry og timeout',
        'Vektet fordeling for kanarilansering av ny modellversjon',
        'Inference-aware ruting til egne modeller etter kø og lastnivå',
        'Helsesjekk og automatisk utkobling av instanser som feiler',
      ],
      options: [
        'Primær + reserve per virtuelt navn',
        'Billigst først innenfor residenskrav',
        'Lavest latens',
      ],
      status: 'planlagt',
    },
    {
      id: 'nokler',
      name: 'Nøkler og legitimasjon',
      tagline: 'Leverandørnøkler ut av koden, inn i gatewayen',
      description:
        'Nøkler og skylegitimasjon til leverandørene ligger kun i gatewayen og roteres ett sted. Virksomheter og tjenester får egne virtuelle nøkler som gatewayen utsteder, med budsjett, tillatte modeller og utløp. En nøkkel bærer alltid hvem den handler på vegne av.',
      capabilities: [
        'Sentral oppbevaring og rotasjon av leverandørlegitimasjon',
        'Virtuelle nøkler per organisasjon, tjeneste og miljø',
        'Nøkkel knyttet til principal, tillatte modeller og utløpsdato',
        'Isolasjon av legitimasjon mellom team som deler gateway',
        'Innlogging for administratorer via fellesløsningene',
      ],
      status: 'delvis',
    },
    {
      id: 'kvoter',
      name: 'Kvoter, budsjett og ratebegrensning',
      tagline: 'Token-grenser per organisasjon, tjeneste og modell',
      description:
        'Forbruk telles i tokens og kroner på hver nøkkel. Grenser kan settes per organisasjon, tjeneste, modell eller tidsvindu, og gatewayen avviser kall som ville gått over. Kostnad attribueres slik at hver virksomhet ser sin egen regning.',
      capabilities: [
        'Token- og kostnadsbudsjett per nøkkel, med myk og hard grense',
        'Ratebegrensning per sekund, minutt og dag',
        'Pris per modell i katalogen, forbruk i sanntid',
        'Kostnadsattribusjon per organisasjon, tjeneste og modell',
        'Varsler når budsjett nærmer seg grensen',
      ],
      practices: [
        'Åpne kanaler får alltid en hard dagsgrense',
        'Budsjett settes i tjenestedefinisjonen, ikke i koden',
      ],
      status: 'delvis',
    },
    {
      id: 'residens',
      name: 'Dataresidens og policy',
      tagline: 'Hvor data kan behandles, håndhevet på hvert kall',
      description:
        'Hver modell i katalogen er merket med hvor den kjører: Norge, EU eller globalt. En tjeneste sier hvilket krav den har, og gatewayen avviser ruting som bryter det. Policyer kan også begrense hvilke identiteter som ser og kan bruke hvilke modeller.',
      capabilities: [
        'Residens per modell: norway, eu, global',
        'Krav per tjeneste, sjekket ved publisering og ved hvert kall',
        'Autorisasjonspolicyer: hvem kan bruke hvilke modeller',
        'Allow- og deny-lister for modeller per organisasjon',
        'Egne og nasjonale modeller (Sigma2) som førstevalg der kravet er Norge',
      ],
      status: 'bygd',
    },
    {
      id: 'observability',
      name: 'Observability og kostnadsanalyse',
      tagline: 'Hvilken modell svarte, hvor lang tid tok det, hva kostet det',
      description:
        'Gatewayen rapporterer per kall hvilken modell som faktisk svarte, antall tokens inn og ut, tid til første token og om en fallback slo inn. Alt følger OpenTelemetry GenAI-konvensjonene, så det kan sendes til samme sporingsverktøy som resten av plattformen uten egen instrumentering i tjenestene.',
      capabilities: [
        'Metrikker per kall: modell, tokens, latens, tid til første token, fallback',
        'OpenTelemetry GenAI-konvensjoner, eksport til sporing',
        'Kostnad og forbruk per nøkkel, organisasjon og modell over tid',
        'Feilrate og tilgjengelighet per leverandør',
        'Bruk som kilde for fakturering og kapasitetsplanlegging',
      ],
      status: 'delvis',
    },
    {
      id: 'mcp-gateway',
      name: 'MCP-gateway',
      tagline: 'Én katalog over verktøy, filtrert per identitet',
      description:
        'Samme gateway kan stå foran MCP-servere. Agenter ser ett verktøykatalog, mens gatewayen bestemmer hvilke verktøy hver identitet får oppdage og kalle. Legitimasjon mot verktøyene holdes i gatewayen, på samme måte som for modellene.',
      capabilities: [
        'Samler verktøy fra mange MCP-servere i én katalog',
        'Filtrering per identitet, så en agent ser et lite, relevant sett',
        'Autentisering mot MCP-servere uten nøkler i agenten',
        'Logg og ratebegrensning på verktøykall',
      ],
      status: 'planlagt',
    },
    {
      id: 'drift',
      name: 'Drift og plassering',
      tagline: 'Lokalt, i Kubernetes eller som dedikert gateway',
      description:
        'Gatewayen er en kontrollplan over en proxy-basert dataplan. Samme konfigurasjon kan kjøre lokalt på en utviklermaskin, i et Kubernetes-cluster eller som en dedikert gateway i flere regioner. Det gjør det mulig å ha én gateway for hele forvaltningen, eller én per virksomhet, uten å endre tjenestene.',
      capabilities: [
        'Samme konfigurasjon lokalt, i Kubernetes og på dedikert gateway',
        'Multiregion med residens per region',
        'Proxy-basert dataplan som tåler høy last',
        'Konfigurasjon som kode, versjonert i Git',
      ],
      status: 'planlagt',
    },
  ],

  /* ---------------------------------------------------------------- Språkmodeller */
  sprakmodeller: [
    {
      id: 'frontier',
      name: 'Kommersielle frontier-modeller',
      tagline: 'De mest kapable modellene, levert som tjeneste',
      description:
        'Frontier-modellene fra de store leverandørene gir best resultat på krevende oppgaver: lang resonnering, kode, agentarbeid over mange steg. Anthropic tilbyr Claude Opus og Claude Fable, OpenAI GPT-6 Astra, Google Gemini. De nås gjennom skyleverandørenes EU-regioner, og gatewayen håndhever hvilke tjenester som får bruke dem.',
      capabilities: [
        'Claude Opus 5.5 og Claude Fable 5.1 fra Anthropic',
        'GPT-6 Astra fra OpenAI, med flere nivåer av resonnering',
        'Gemini fra Google',
        'Tilgjengelig via Azure AI Foundry, AWS Bedrock og Google Vertex i EU',
        'Verktøykall, strukturert utdata, lange kontekstvinduer',
      ],
      practices: [
        'Bruk frontier-modeller der kvalitet er avgjørende, mindre modeller der oppgaven er enkel',
        'Sjekk residens og databehandleravtale før en tjeneste får bruke modellen',
      ],
      status: 'bygd',
    },
    {
      id: 'norske',
      name: 'Norske modeller',
      tagline: 'Trent på norsk tekst og tale av Nasjonalbiblioteket og forskningsmiljøene',
      description:
        'Nasjonalbibliotekets KI-lab (NbAiLab) trener og publiserer åpne modeller for bokmål, nynorsk og samisk. Borealis er den nyeste familien: instruksjonsmodeller bygd på Gemma 3 i fem størrelser fra 270M til 27B, med egne «open»-varianter uten materiale fra avtalen med rettighetshaverne. Før den kom NB-Llama og NoTraM-serien bygd på Llama, NB-BERT og nb-sbert for forståelse og embeddings, og NB-Whisper for tale. Mímir-prosjektet, der Nasjonalbiblioteket, NTNU, UiO og Sigma2 samarbeider, bygger neste generasjon på Olivia.',
      capabilities: [
        'Borealis: instruksjonsmodeller for bokmål og nynorsk på Gemma 3, 270M til 27B, også som GGUF og MLX',
        'NB-Llama og NoTraM: instruksjonsmodeller for norsk, 1B til 70B',
        'NB-BERT og nb-sbert: forståelse og embeddings',
        'NB-Whisper og wav2vec2: tale til tekst på bokmål og nynorsk',
        'Åpne vekter på Hugging Face, kan driftes i Norge',
        'Mímir: neste generasjon norske modeller trent på Olivia',
      ],
      practices: [
        'Evaluer norske modeller på eget testsett, ikke bare på engelske benchmarks',
        'Bruk norsk embeddingsmodell for søk i norske dokumenter',
        'Sjekk lisensen: Borealis har egne bruksvilkår, «open»-variantene følger Gemma-lisensen',
      ],
      status: 'delvis',
    },
    {
      id: 'apne',
      name: 'Åpne vektmodeller',
      tagline: 'Modeller som kan lastes ned og driftes selv',
      description:
        'Åpne vektmodeller kan kjøres hos Sigma2, Telenor AI Factory eller i egen drift, og gir full kontroll over data og kostnad. De beste er i 2026 nær frontier-modellene på mange oppgaver: DeepSeek V4, Qwen 3.x, Llama 4, Gemma 4, Mistral, GLM og OpenAIs gpt-oss. Lisensen varierer og må sjekkes per modell.',
      capabilities: [
        'DeepSeek V4, Qwen 3.x, Llama 4, Gemma 4, Mistral, GLM, gpt-oss',
        'Størrelser fra 1B for enkle oppgaver til store MoE-modeller',
        'Kjøres med vLLM eller tilsvarende inferensserver',
        'Lisens per modell: Apache 2.0, MIT eller egne vilkår',
        'Kvantisering for å kjøre på mindre GPU-er',
      ],
      options: [
        'Stor MoE-modell for kvalitet',
        'Mellomstor tett modell for balanse',
        'Liten modell for klassifisering og omskriving',
      ],
      status: 'delvis',
    },
    {
      id: 'embeddings',
      name: 'Embeddings og reranking',
      tagline: 'Modellene bak søket',
      description:
        'Søk i egne data krever to andre modelltyper: embeddingsmodeller som gjør tekst til vektorer, og rerankere som rangerer treff presist. Begge må forstå norsk godt og kjøre innenfor samme residenskrav som svarmodellen.',
      capabilities: [
        'Flerspråklige embeddingsmodeller med norsk dekning',
        'Norske embeddingsmodeller fra NbAiLab',
        'Cross-encoder- og ColBERT-rerankere',
        'Versjonert i katalogen, bytte krever reindeksering',
      ],
      status: 'bygd',
    },
    {
      id: 'tale',
      name: 'Tale og syn',
      tagline: 'Tale til tekst, tekst til tale og bilder',
      description:
        'KI-tjenester trenger ofte mer enn tekst: transkripsjon av møter og telefoner, opplesning for universell utforming, og tolking av bilder og skannede dokumenter. Modellene velges i samme katalog som språkmodellene.',
      capabilities: [
        'Tale til tekst med NB-Whisper for norsk',
        'Tekst til tale for opplesning',
        'Multimodale modeller for bilder og dokumenter',
        'OCR for skannet materiale',
      ],
      status: 'planlagt',
    },
    {
      id: 'modellvalg',
      name: 'Modellvalg og evaluering',
      tagline: 'Velg modell på fakta, bytt når noe bedre kommer',
      description:
        'Modeller kommer og går. Katalogen i gatewayen sier hva hver modell kan, hvor den kjører og hva den koster. Testsettene i kvalitetslaget sier hvor godt den faktisk svarer på virksomhetens oppgaver. Sammen gir de grunnlag for å velge, og for å bytte trygt gjennom publiseringsportene.',
      capabilities: [
        'Kapabiliteter, residens og pris i katalogen',
        'Eksperiment per modell på eget testsett',
        'Kanarilansering av ny modell',
        'Levende data fra Hugging Face om nye modeller',
      ],
      practices: [
        'Ha alltid en reservemodell innenfor samme residenskrav',
        'Bytt modell gjennom publiseringsportene, aldri direkte i produksjon',
      ],
      status: 'delvis',
    },
  ],

  /* ---------------------------------------------------------------- Infrastruktur for KI */
  'ki-infrastruktur': [
    {
      id: 'sigma2',
      name: 'Sigma2 og Olivia',
      tagline: 'Nasjonal regnekraft for forskning og forvaltning',
      description:
        'Sigma2 drifter de nasjonale e-infrastrukturtjenestene. Superdatamaskinen Olivia i Lefdal Mine Datacenter har 448 Nvidia Grace Hopper-brikker etter utvidelsen i 2026 og er bygd for å trene og kjøre språkmodeller for norsk og samisk. Deler av kapasiteten er tilgjengelig for forvaltningen.',
      capabilities: [
        '448 Nvidia GH200 Grace Hopper-brikker',
        'Trening av norske modeller i Mímir-prosjektet',
        'Kapasitet for forvaltning og næringsliv',
        'Data blir i Norge',
      ],
      status: 'planlagt',
    },
    {
      id: 'telenor',
      name: 'Telenor AI Factory',
      tagline: 'Suveren GPU-kapasitet i norske datasentre',
      description:
        'Telenor AI Factory er en kommersiell plattform for KI-arbeidslaster på Nvidia-GPU-er i datasentre i Norge, drevet på fornybar energi. Den er laget for virksomheter som må behandle sensitive data innenlands, med Red Hat OpenShift AI som miljø for å kjøre modeller og agenter.',
      capabilities: [
        'Nvidia H100 og nyere GPU-er i Norge',
        'Red Hat OpenShift AI som plattform',
        'Inferens av åpne modeller som tjeneste',
        'Fornybar energi og gjenbruk av varme',
      ],
      status: 'planlagt',
    },
    {
      id: 'sky',
      name: 'Sky',
      tagline: 'Modeller som tjeneste i EU-regioner',
      description:
        'Skyleverandørene tilbyr frontier-modeller som tjeneste: Azure AI Foundry (OpenAI og Anthropic), AWS Bedrock og Google Vertex. Genki bruker Azure AI Foundry i dag, med deployments i EU. Modellene kjører hos leverandøren, og residens settes per modell i katalogen.',
      capabilities: [
        'Azure AI Foundry med GPT og Claude',
        'AWS Bedrock og Google Vertex via gatewayen',
        'EU-regioner og databehandleravtaler',
        'Automatisk oppdagelse av deployments',
      ],
      status: 'bygd',
    },
    {
      id: 'egen-drift',
      name: 'Egen drift',
      tagline: 'Åpne modeller på egne GPU-er',
      description:
        'Digdir eksperimenterer med egen drift av åpne modeller i laben aivar. En inferensserver som vLLM eksponerer modellen gjennom et OpenAI-kompatibelt API, og gatewayen ruter til den som til enhver annen modell. Gir full kontroll, men krever GPU-er og driftskompetanse.',
      capabilities: [
        'vLLM eller tilsvarende med OpenAI-kompatibelt API',
        'Åpne og norske modeller',
        'Full kontroll på data og kostnad',
        'Inference-aware ruting fra gatewayen',
      ],
      practices: [
        'Start med inferens av åpne modeller, ikke trening',
        'Mål faktisk kostnad per million tokens mot sky før skalering',
      ],
      status: 'delvis',
    },
    {
      id: 'flere',
      name: 'Flere leverandører',
      tagline: 'Ikke begrenset til noen få: alt som snakker et åpent API kan kobles på',
      description:
        'KI-porten gjør leverandørvalget til konfigurasjon. Det betyr at Genki ikke er bundet til Sigma2, Telenor eller én sky. Norske datasentre bygger nå GPU-kapasitet i stor skala, europeiske neoclouds tilbyr GPU-er som tjeneste med data i EU, og de store skyleverandørene har modeller som tjeneste i EU-regioner. Valget styres av residens, pris, kapasitet og hva virksomheten allerede har avtale med.',
      capabilities: [
        'Alle leverandører med OpenAI-kompatibelt API eller egen adapter i gatewayen',
        'Residens per leverandør og region i modellkatalogen',
        'Flere leverandører samtidig, med failover mellom dem',
        'Pris og kapasitet sammenlignet på samme måleskala',
      ],
      options: [
        'Norske datasentre: Stargate Norway (Nscale og Aker, Narvik), Green Mountain, Bulk Infrastructure, Lefdal Mine Datacenter, Telenor AI Factory, Sigma2',
        'Neoclouds: Nscale, Nebius, CoreWeave, Crusoe, Lambda, Fluidstack',
        'Store skyer: Microsoft Azure, AWS, Google Cloud, Oracle Cloud',
        'Europeiske skyer: OVHcloud, Scaleway, IONOS',
      ],
      practices: [
        'Krev OpenAI-kompatibelt API og OpenTelemetry fra nye leverandører',
        'Sjekk databehandleravtale og residens før en leverandør legges i katalogen',
      ],
      status: 'planlagt',
    },
  ],

  /* ---------------------------------------------------------------- Kunnskap (RAG) */
  rag: [
    {
      id: 'innhenting',
      name: 'Datakilder og innhenting',
      tagline: 'Hent dokumentene dit de skal søkes i, og hold dem oppdatert',
      description:
        'Innhenting (ingestion) kobler et datasett til kildene det skal bygges fra: filer, nettsider, databaser, API-er, arkiv og samhandlingsverktøy. Kjøringen er inkrementell, så bare endrede dokumenter behandles på nytt, og tilgangsinformasjon fra kilden følger dokumentet inn i indeksen.',
      capabilities: [
        'Koblinger til filer, Parquet, Postgres, HTTP, nettsider og MCP-kilder',
        'Inkrementell oppdatering: nye, endrede og slettede dokumenter',
        'Deduplisering og dokument-ID på tvers av kjøringer',
        'Tilgangsmetadata (ACL) fra kilden følger dokumentet',
        'Planlagte kjøringer og kjøring ved publisering',
      ],
      practices: [
        'Én kilde per datasett der mulig, så eierskap og tilgang er klart',
        'Lagre kildens oppdateringstidspunkt som metadata',
      ],
      status: 'bygd',
    },
    {
      id: 'dokumentbehandling',
      name: 'Dokumentbehandling',
      tagline: 'Fra PDF, Word og HTML til ren tekst med struktur',
      description:
        'Før tekst kan deles opp må den hentes ut av formatet. God dokumentbehandling bevarer overskrifter, lister og tabeller, kjenner igjen sidetall og kapitler, og kjører OCR på skannede sider. Resultatet er Markdown med metadata, som alle senere steg bygger på.',
      capabilities: [
        'PDF, Word, PowerPoint, HTML og e-post til Markdown',
        'Bevarer overskrifter, lister, tabeller og lenker',
        'OCR for skannede dokumenter og bilder',
        'Uttrekk av metadata: tittel, dato, forfatter, språk, kapittel',
        'Språkdeteksjon for bokmål, nynorsk, samisk og engelsk',
      ],
      status: 'bygd',
    },
    {
      id: 'chunking',
      name: 'Chunking',
      tagline: 'Del teksten i biter som gir mening alene',
      description:
        'Chunking deler dokumentene i biter som indekseres hver for seg. Strategien avgjør kvaliteten på søket: for små biter mister sammenheng, for store drukner det relevante. Beste praksis er strukturbasert deling som følger overskrifter, med overlapp og en lenke til foreldredokumentet så modellen kan få mer kontekst ved behov.',
      capabilities: [
        'Strategi velges per datasett i konfigurasjon',
        'Overlapp mellom biter så setninger ikke kuttes',
        'Metadata på hver bit: dokument, kapittel, side, språk',
        'Foreldre–barn: søk i små biter, send større kontekst til modellen',
        'Tabeller og kodeblokker holdes samlet',
      ],
      options: [
        'Fast størrelse med overlapp',
        'Rekursiv etter struktur (overskrifter, avsnitt, setninger)',
        'Semantisk deling der temaet skifter',
        'Setningsvindu med kontekst rundt treffet',
      ],
      status: 'bygd',
    },
    {
      id: 'embeddings',
      name: 'Embeddings og indeksering',
      tagline: 'Vektorer og nøkkelord, i en indeks som kan byttes',
      description:
        'Hver bit får en embedding fra en modell som forstår norsk, og lagres i en vektorindeks sammen med en klassisk fulltekstindeks. Indeksen sitter bak en port, så Typesense, pgvector eller en annen motor kan byttes i konfigurasjon. Embeddingsmodellen er versjonert, for når den byttes må alt indekseres på nytt.',
      capabilities: [
        'Flerspråklige embeddingsmodeller med god dekning for norsk',
        'Vektorindeks (HNSW) og fulltekstindeks (BM25) side om side',
        'Fasetter og metadatafelter for filtrering',
        'Versjonert indeks, reindeksering uten nedetid',
        'Søkemotor bak en port: Typesense og pgvector innebygd',
      ],
      practices: [
        'Embeddingsmodell innenfor samme residenskrav som svarmodellen',
        'Test embeddingsmodeller på eget testsett før bytte',
      ],
      status: 'bygd',
    },
    {
      id: 'gjenfinning',
      name: 'Gjenfinning',
      tagline: 'Semantisk søk, nøkkelordsøk og hybrid, med tilgangsfilter',
      description:
        'Gjenfinning (retrieval) finner bitene som kan svare på spørsmålet. Semantisk søk fanger mening, nøkkelordsøk fanger eksakte termer og saksnumre, og hybridsøk slår dem sammen. Spørsmålet kan omskrives eller deles i flere før søket, og tilgangsfilteret sørger for at ingen får treff de ikke har rett til å se.',
      capabilities: [
        'Semantisk søk, nøkkelordsøk og hybrid med rangeringsfusjon (RRF)',
        'Metadatafiltre: datasett, dato, dokumenttype, språk',
        'Tilgangsfiltrering på dokumentnivå før rangering',
        'Omskriving av spørsmål og flere delspørsmål (multi-query)',
        'Topp-k og terskler konfigurert per tjeneste',
      ],
      options: [
        'Hybrid som standard',
        'Bare semantisk for naturlig språk',
        'Bare nøkkelord for koder og referanser',
      ],
      status: 'bygd',
    },
    {
      id: 'reranking',
      name: 'Reranking',
      tagline: 'La en presis modell velge de beste kildene',
      description:
        'Første søk henter mange kandidater raskt. En reranker leser spørsmål og kandidat sammen og gir en mer presis rangering, så bare de beste bitene sendes til modellen. Det gir bedre svar og lavere kostnad, fordi konteksten blir kortere.',
      capabilities: [
        'Cross-encoder eller ColBERT-reranker bak en port',
        'Hent 30–50 kandidater, send 5–10 videre',
        'Terskel som fjerner svake treff i stedet for å fylle opp',
        'Reranker-modell innenfor residenskravet',
      ],
      status: 'bygd',
    },
    {
      id: 'kontekst',
      name: 'Kontekst og kildehenvisning',
      tagline: 'Bygg prompten og la svaret peke tilbake på kildene',
      description:
        'De valgte bitene settes sammen til kontekst innenfor et tokenbudsjett, med kilde-ID på hver bit. Modellen instrueres til å henvise til kildene, og svaret leveres med nummererte referanser som kan vises som lenker og brukes i evalueringer av faktatroskap.',
      capabilities: [
        'Kontekstbudsjett i tokens per tjeneste',
        'Deduplisering og sammenslåing av biter fra samme dokument',
        'Nummererte kilder i svaret og i API-et',
        'Lenke til dokument, side og avsnitt',
        'Avvisning når ingen kilder er gode nok',
      ],
      practices: [
        'Be modellen svare «vet ikke» uten kilder heller enn å gjette',
        'Vis kildene til brukeren, alltid',
      ],
      status: 'bygd',
    },
    {
      id: 'datasett',
      name: 'Datasett og livssyklus',
      tagline: 'Eierskap, tilgang, versjoner og sletting',
      description:
        'Et datasett eies av en virksomhet og har egen tilgangsstyring, så bare tjenester med rett kan søke i det. Innhold versjoneres med innhentingskjøringene, kan rulles tilbake, og slettes helt når kilden eller avtalen krever det.',
      capabilities: [
        'Datasett per virksomhet, delt med andre bare ved eksplisitt tilgang',
        'Versjoner per innhentingskjøring, med tilbakerulling',
        'Sletting og oppbevaring etter regelverk',
        'Kvalitetsrapport: dokumenter, biter, feil og dekning',
        'Deles på tvers av forvaltningen når data er åpne',
      ],
      status: 'delvis',
    },
  ],

  /* ---------------------------------------------------------------- Kvalitet */
  evals: [
    {
      id: 'sporing',
      name: 'Sporing',
      tagline: 'Hver forespørsel som en trace med alle stegene',
      description:
        'Hvert kall logges som en trace med underliggende spans: søk, modellkall, verktøykall og guardrails, hver med varighet, tokens og kostnad. Traces grupperes i sesjoner og per bruker, så en samtale kan leses i sammenheng. Innsamlingen følger OpenTelemetry, så plattformen er ikke bundet til ett verktøy.',
      capabilities: [
        'Trace per forespørsel, span per steg: søk, modell, verktøy, guardrail',
        'Inn- og utdata, latens, tokens og kostnad på hvert span',
        'Sesjoner og brukere for å følge en samtale',
        'OpenTelemetry GenAI-konvensjoner',
        'Maskering av persondata før lagring',
      ],
      status: 'bygd',
    },
    {
      id: 'instruksjoner',
      name: 'Instruksjonsforvaltning',
      tagline: 'Prompter som versjonerte artefakter, ikke tekst i koden',
      description:
        'Instruksjoner (prompter) forvaltes utenfor koden med versjoner, merkelapper som «produksjon» og «test», og variabler. En endring kan prøves på en andel av trafikken, sammenlignes og rulles tilbake. Hver trace vet hvilken versjon som ble brukt.',
      capabilities: [
        'Versjonerte instruksjoner med merkelapper per miljø',
        'Variabler og maler, delt mellom tjenester',
        'Kobling fra trace til instruksjonsversjon',
        'Tilbakerulling på sekunder',
        'Sammenligning av to versjoner på samme testsett',
      ],
      status: 'delvis',
    },
    {
      id: 'skarer',
      name: 'Skårer og tilbakemelding',
      tagline: 'Tommel opp, tall og kategorier, koblet til hvert svar',
      description:
        'En skår er en vurdering knyttet til en trace: fra brukeren (tommel opp eller ned), fra en automatisk dommer eller fra en fagperson. Skårer kan være tall, kategorier eller kommentarer, og brukes både til å finne svake svar og til å bygge testsett fra ekte trafikk.',
      capabilities: [
        'Brukertilbakemelding fra alle kanaler som skår på oppgaven',
        'Numeriske, boolske og kategoriske skårer',
        'Flere skårer per trace: relevans, faktatroskap, tone',
        'Filtrering og søk på skårer for å finne feil',
        'Eksport av svake svar til testsett',
      ],
      status: 'bygd',
    },
    {
      id: 'dommere',
      name: 'Automatiske dommere',
      tagline: 'LLM-som-dommer på produksjonstrafikk og testsett',
      description:
        'En dommer er en evaluering som kjører automatisk: deterministiske sjekker (format, lengde, forbudte ord) og modellbaserte dommere som vurderer relevans, faktatroskap mot kildene, fullstendighet og tone. Dommere kjører på en andel av produksjonstrafikken og på hele testsett ved hver versjon.',
      capabilities: [
        'Deterministiske dommere: skjema, lengde, språk, forbudt innhold',
        'LLM-som-dommer forankret i kildene: faktatroskap, relevans, fullstendighet',
        'Sikkerhetsdommere: skadelig innhold, lekkasje av persondata',
        'Egne dommer-maler per tjeneste',
        'Kjøres på utvalg av produksjon og på alle testsett',
      ],
      practices: [
        'Dommeren bruker en annen modell enn tjenesten',
        'Kalibrer dommere mot menneskelige vurderinger',
      ],
      status: 'bygd',
    },
    {
      id: 'testsett',
      name: 'Testsett og eksperimenter',
      tagline: 'Kjør hver versjon på de samme casene og sammenlign',
      description:
        'Et testsett er en samling cases med spørsmål, forventet svar og kilder, gjerne hentet fra ekte trafikk. Et eksperiment kjører en versjon av tjenesten gjennom hele settet og lagrer resultatene, så to versjoner kan sammenlignes case for case før den nye slippes.',
      capabilities: [
        'Versjonerte testsett eid av virksomheten',
        'Split i train, validation og locked så ingen optimaliserer mot testen',
        'Eksperiment per versjon, med resultat per case',
        'Sammenligning side om side og regresjonsvarsel',
        'Parity-harness mot eksisterende løsninger',
      ],
      status: 'bygd',
    },
    {
      id: 'annotering',
      name: 'Manuell vurdering',
      tagline: 'Køer der fagpersoner vurderer svar etter retningslinjer',
      description:
        'Noen vurderinger krever et menneske: er svaret juridisk riktig, er tonen passende for målgruppen. Annoteringskøer sender et utvalg traces til fagpersoner med klare retningslinjer, samler vurderingene som skårer og bruker dem til å kalibrere de automatiske dommerne.',
      capabilities: [
        'Køer med utvalg fra produksjon eller testsett',
        'Retningslinjer og skala per kø',
        'Flere vurderere per case, med enighet som mål',
        'Vurderingene blir skårer og nye testcases',
      ],
      status: 'planlagt',
    },
    {
      id: 'porter',
      name: 'Publiseringsporter',
      tagline: 'En ny versjon må bestå før den når brukerne',
      description:
        'Portene ligger i tjenestedefinisjonen: hvilke testsett som må kjøres og hvilke terskler dommerne må nå. Publisering stoppes automatisk hvis en terskel ikke nås, og resultatet lagres med versjonen, så det alltid kan dokumenteres hvorfor en versjon ble sluppet.',
      capabilities: [
        'Terskler per dommer og testsett i definisjonen',
        'Automatisk stopp av publisering ved brudd',
        'Resultat lagret med versjonen for revisjon',
        'Porter for både instruksjons- og modellbytte',
      ],
      status: 'bygd',
    },
    {
      id: 'dashboards',
      name: 'Dashboards og varsler',
      tagline: 'Bruk, kostnad, latens og kvalitet over tid',
      description:
        'Nøkkeltall per tjeneste, organisasjon og modell: antall kall, tokens og kostnad, latens, feilrate og gjennomsnittlige skårer. Varsler går når kostnad, feilrate eller kvalitet avviker fra normalen.',
      capabilities: [
        'Bruk og kostnad per tjeneste, organisasjon og modell',
        'Latens og feilrate over tid',
        'Kvalitetstrend fra skårer og dommere',
        'Varsler på avvik',
      ],
      status: 'delvis',
    },
    {
      id: 'playground',
      name: 'Playground',
      tagline: 'Prøv instruksjon, modell og datasett før du publiserer',
      description:
        'Et sted å teste en endring med en gang: samme spørsmål mot to instruksjoner eller to modeller side om side, med kilder og kostnad synlig. Det som fungerer kan lagres som ny versjon og sendes gjennom portene.',
      capabilities: [
        'Side om side-sammenligning',
        'Kjør et testsett direkte fra playground',
        'Lagre som ny versjon',
      ],
      status: 'bygd',
    },
  ],

  /* ---------------------------------------------------------------- Autentisering */
  autentisering: [
    {
      id: 'id-porten',
      name: 'ID-porten',
      tagline: 'Innbyggere logger inn med BankID, MinID eller annen eID',
      description:
        'ID-porten er den nasjonale påloggingen for innbyggere mot offentlige tjenester. Tjenesten får en bekreftet identitet (fødselsnummer) og et sikkerhetsnivå, uten å forholde seg til hvilken eID personen brukte. Brukes når en KI-tjeneste rettes mot innbyggere og må vite hvem de er.',
      capabilities: [
        'OpenID Connect med sikkerhetsnivå substansielt og høyt',
        'BankID, MinID, Buypass, Commfides og eIDAS-eID-er',
        'Bekreftet fødselsnummer i token',
        'Single sign-on mellom offentlige tjenester',
        'Testmiljø med testbrukere',
      ],
      status: 'planlagt',
    },
    {
      id: 'ansattporten',
      name: 'Ansattporten',
      tagline: 'Ansatte logger inn gjennom egen virksomhets identitetsleverandør',
      description:
        'Ansattporten lar ansatte i offentlig sektor logge inn med virksomhetens egen løsning, for eksempel Entra ID, og gir tjenesten et token som sier hvem personen er og hvilken virksomhet de representerer. Genki bruker Ansattporten for alle som jobber i arbeidsflaten og portalen.',
      capabilities: [
        'OpenID Connect med virksomhetens egen identitetsleverandør bak',
        'Organisasjonsnummer og person i samme token',
        'Valg av virksomhet for personer med flere roller',
        'Kombineres med Altinn Autorisasjon for rettigheter',
        'Testmiljø og mock med testpersoner lokalt',
      ],
      status: 'bygd',
    },
    {
      id: 'maskinporten',
      name: 'Maskinporten',
      tagline: 'Systemer autentiserer seg med virksomhetssertifikat, uten brukere',
      description:
        'Maskinporten gir maskin-til-maskin-tilgang: et system signerer en forespørsel med virksomhetens sertifikat og får et token med organisasjonsnummer og avtalte scopes. Brukes når et fagsystem eller en agent kaller Genki uten at en person er innlogget.',
      capabilities: [
        'OAuth 2.0 JWT-grant med virksomhetssertifikat',
        'Scopes avtalt per API, organisasjonsnummer i token',
        'Delegering: en leverandør kan handle for en virksomhet',
        'Kortlevde tokens, ingen hemmeligheter i klienten utover sertifikatet',
        'Testmiljø (ver2) for utvikling',
      ],
      status: 'bygd',
    },
    {
      id: 'api-nokler',
      name: 'API-nøkler og principal',
      tagline: 'En nøkkel vet alltid hvem den handler på vegne av',
      description:
        'For klienter som ikke kan bruke Maskinporten, utsteder portalen API-nøkler. Hver nøkkel er bundet til en principal (person eller system i en organisasjon) og en policy som sier hva den kan gjøre. Dermed har hvert kall en kjent identitet uansett kanal.',
      capabilities: [
        'Nøkler utstedt i portalen, knyttet til organisasjon og principal',
        'Policy per nøkkel: tjenester, datasett, budsjett',
        'Utløp, rotasjon og tilbakekalling',
        'Samme principal-modell for Ansattporten, Maskinporten og nøkler',
      ],
      status: 'bygd',
    },
    {
      id: 'operatorer',
      name: 'Operatørpålogging',
      tagline: 'Digdirs driftere logger inn med Entra ID',
      description:
        'De som drifter plattformen trenger en egen pålogging med sterk autentisering og egne roller, skilt fra virksomhetenes brukere. Operatører logger inn via Entra ID og alle admin-operasjoner krever begrunnelse og havner i revisjonsloggen.',
      capabilities: [
        'Entra ID med MFA for operatører',
        'Egne roller skilt fra virksomhetsbrukere',
        'Begrunnelse og revisjonslogg på admin-operasjoner',
      ],
      status: 'bygd',
    },
    {
      id: 'sesjon',
      name: 'Sesjoner og tokens',
      tagline: 'Kortlevde tokens, sikker utlogging, test-mock lokalt',
      description:
        'Uansett pålogging ender alt i samme interne identitet med sesjon og kortlevde tokens. Utlogging propagerer til fellesløsningen, og i utviklingsmodus erstattes alt av en mock med faste testpersoner så alle kan kjøre plattformen lokalt.',
      capabilities: [
        'Felles identitetsmodell uansett kilde',
        'Kortlevde tokens med fornyelse',
        'Utlogging mot fellesløsningen',
        'Mock-pålogging med testpersoner lokalt',
      ],
      status: 'bygd',
    },
  ],

  /* ---------------------------------------------------------------- Tilgangsstyring */
  tilgangsstyring: [
    {
      id: 'altinn-autorisasjon',
      name: 'Altinn Autorisasjon',
      tagline: 'Hvem har rett til hva, på vegne av hvilken virksomhet',
      description:
        'Altinn Autorisasjon er den nasjonale løsningen for rettigheter i offentlig sektor. En tjeneste spør om en person eller et system har en gitt rettighet for en virksomhet, og får svar basert på roller fra Enhetsregisteret og delegeringer virksomheten selv har gjort. Genki henter rettigheter herfra per organisasjon.',
      capabilities: [
        'Rettighetssjekk (PDP) per person, system og organisasjon',
        'Roller fra Enhetsregisteret: daglig leder, styreleder, regnskapsfører',
        'Delegering fra virksomhet til personer, systemer og leverandører',
        'Policy per ressurs i XACML, evaluert sentralt',
        'Testmiljø tt02 med testorganisasjoner',
      ],
      status: 'bygd',
    },
    {
      id: 'ressursregisteret',
      name: 'Ressursregisteret',
      tagline: 'Registrer KI-tjenesten som en ressurs det kan gis tilgang til',
      description:
        'For at Altinn skal kunne styre tilgang til en tjeneste, må tjenesten finnes som ressurs i Ressursregisteret med en policy. Hver KI-tjeneste i Genki kan registreres slik, så virksomheten styrer hvem som får bruke den med de samme verktøyene de bruker for andre offentlige tjenester.',
      capabilities: [
        'Tjeneste registrert som ressurs med eier, beskrivelse og policy',
        'Delegerbare rettigheter per ressurs',
        'Synlig i Altinn for virksomhetens administratorer',
        'Automatisk registrering ved publisering av en tjeneste',
      ],
      status: 'planlagt',
    },
    {
      id: 'tilgangspakker',
      name: 'Tilgangspakker og roller',
      tagline: 'Ferdige pakker i stedet for enkeltrettigheter',
      description:
        'Tilgangspakker samler rettigheter som hører sammen, for eksempel «KI-tjenester for saksbehandling», så en administrator gir én pakke i stedet for ti enkeltrettigheter. Pakker og roller gjør det mulig å styre tilgang for hele avdelinger på én gang.',
      capabilities: [
        'Pakker av rettigheter definert av tjenesteeier',
        'Roller for ansatte, tjenesteeiere og administratorer',
        'Gruppevis tildeling',
        'Oversikt over hvem som har hva',
      ],
      status: 'planlagt',
    },
    {
      id: 'systembrukere',
      name: 'Systembrukere',
      tagline: 'Gi et system rettigheter som om det var en ansatt',
      description:
        'En systembruker er en identitet for et fagsystem eller en leverandør som handler på vegne av virksomheten. Kombinert med Maskinporten får systemet et token, og Altinn svarer på hva det har rett til. Slik kan et arkivsystem kalle en KI-agent uten en innlogget person.',
      capabilities: [
        'Systembruker opprettet og godkjent av virksomheten',
        'Rettigheter delegert som til en person',
        'Kobling til Maskinporten-klient',
        'Tilbakekalling uten å endre systemet',
      ],
      status: 'planlagt',
    },
    {
      id: 'plattformrettigheter',
      name: 'Plattformrettigheter',
      tagline: 'Administrere tjenester, datasett, tilgang og forbruk er hver sin rett',
      description:
        'Inne i Genki er rettighetene eksplisitte og finmaskede: å endre en tjeneste, legge til data, gi andre tilgang eller se forbruk er hver sin rett, og de kan delegeres videre. Det gir en virksomhet mulighet til å la fagavdelingen bygge tjenester uten at de kan endre tilgang eller budsjett.',
      capabilities: [
        'Rettigheter per handling: tjenester, datasett, tilgang, forbruk, publisering',
        'Delegering med sporing av hvem som ga hva',
        'Rettigheter per organisasjon og per tjeneste',
        'Revisjonslogg for alle endringer',
      ],
      status: 'bygd',
    },
    {
      id: 'datatilgang',
      name: 'Tilgang til data',
      tagline: 'Hvem får se hvilke dokumenter, helt ned på treffnivå',
      description:
        'Tilgang stopper ikke ved tjenesten. Et datasett kan ha tilgangsregler fra kilden, og søket filtrerer treff etter hva den som spør har rett til å se, før modellen får konteksten. Tenant-isolasjon i databasen sikrer at ingen spørring krysser organisasjonsgrenser.',
      capabilities: [
        'Tilgangsregler per datasett og per dokument',
        'Filtrering før rangering, aldri etter',
        'Row-level security per tenant',
        'Deling av datasett mellom virksomheter krever eksplisitt vedtak',
      ],
      status: 'delvis',
    },
    {
      id: 'revisjon',
      name: 'Policy-evaluering og revisjon',
      tagline: 'Hver tilgangsbeslutning kan forklares i ettertid',
      description:
        'Hvert kall får en tilgangsbeslutning som logges: hvem, hva, på vegne av hvilken organisasjon, hvilken regel som avgjorde. Det gir grunnlag for innsyn, tilsyn og feilsøking, og gjør det mulig å svare på «hvem brukte denne tjenesten på dette dokumentet».',
      capabilities: [
        'Beslutningslogg per kall',
        'Innsyn for virksomhetens administratorer',
        'Varsling ved uvanlige mønstre',
        'Oppbevaring etter regelverk',
      ],
      status: 'delvis',
    },
  ],

  /* ---------------------------------------------------------------- Applikasjonsplattform */
  plattform: [
    {
      id: 'kjoremiljo',
      name: 'Kjøremiljø og orkestrering',
      tagline: 'Containere som skalerer, oppdateres og overvåkes automatisk',
      description:
        'API, worker og gateway kjører som containere i et orkestrert miljø. Plattformen skalerer etter last, ruller ut nye versjoner uten nedetid, starter det som feiler på nytt og holder helsesjekker på alt som kjører.',
      capabilities: [
        'Containere i Kubernetes eller tilsvarende',
        'Autoskalering på last og kø',
        'Rullende utrulling og tilbakerulling',
        'Helsesjekker og selvhelbreding',
        'Ressursgrenser per komponent',
        'Containere og mikro-VM-er som underlag for agentenes sandkasser',
      ],
      status: 'delvis',
    },
    {
      id: 'utrulling',
      name: 'Utrulling og CI/CD',
      tagline: 'Fra commit til produksjon gjennom tester og miljøer',
      description:
        'All infrastruktur er kode, og hver endring går gjennom en pipeline: bygg, tester, sikkerhetsskanning, signering og utrulling til utvikling, test og produksjon. Konfigurasjon per miljø ligger i Git, så enhver tilstand kan gjenskapes.',
      capabilities: [
        'Infrastruktur som kode (Bicep, Terraform)',
        'Pipeline med tester, skanning og signering',
        'Miljøer: utvikling, test, produksjon',
        'GitOps: ønsket tilstand i Git',
        'Signerte images og SBOM',
      ],
      status: 'delvis',
    },
    {
      id: 'logging',
      name: 'Logging',
      tagline: 'Strukturerte logger, samlet ett sted, uten persondata',
      description:
        'Alle komponenter logger strukturert (JSON) med korrelasjons-ID, så ett kall kan følges gjennom API, kjerne, gateway og worker. Logger samles sentralt, maskeres for persondata, kan søkes i og slettes etter oppbevaringsregler.',
      capabilities: [
        'Strukturerte logger med korrelasjons-ID',
        'Sentral innsamling og søk',
        'Maskering av persondata før lagring',
        'Oppbevaring og sletting etter regelverk',
        'Revisjonslogg for admin-operasjoner, uforanderlig',
      ],
      status: 'delvis',
    },
    {
      id: 'observability',
      name: 'Metrikker, sporing og varsling',
      tagline: 'Se hvordan plattformen har det, før brukerne merker noe',
      description:
        'Metrikker for trafikk, feil, varighet og metning per komponent, distribuert sporing på tvers av tjenester med OpenTelemetry, og dashboards med varsler mot definerte servicenivåmål. Samme sporing som KI-kvaliteten bygger på, så teknisk og faglig innsikt henger sammen.',
      capabilities: [
        'Metrikker (RED/USE) per komponent',
        'Distribuert sporing med OpenTelemetry',
        'Dashboards og servicenivåmål (SLO)',
        'Varsling til vakt',
        'Kapasitets- og kostnadsoppfølging',
      ],
      status: 'delvis',
    },
    {
      id: 'lagring',
      name: 'Lagring og database',
      tagline: 'Postgres med tenant-isolasjon, objektlagring og sikkerhetskopi',
      description:
        'Postgres er primærlager, med row-level security som isolerer hver virksomhet. Dokumenter og store filer ligger i objektlagring. Alt er kryptert i ro og under transport, sikkerhetskopieres automatisk og kan gjenopprettes til et tidspunkt.',
      capabilities: [
        'Postgres med row-level security per tenant',
        'Versjonerte migrasjoner',
        'Objektlagring for dokumenter og artefakter',
        'Kryptering i ro og i transport',
        'Sikkerhetskopi og gjenoppretting til tidspunkt',
      ],
      status: 'bygd',
    },
    {
      id: 'hemmeligheter',
      name: 'Hemmeligheter og konfigurasjon',
      tagline: 'Nøkler i hvelv, konfigurasjon per miljø, funksjonsbrytere',
      description:
        'Hemmeligheter ligger i en nøkkelhvelv-tjeneste og hentes ved oppstart eller ved behov, aldri i kode eller images. Konfigurasjon er versjonert per miljø, og funksjonsbrytere gjør det mulig å slå på nye evner gradvis.',
      capabilities: [
        'Nøkkelhvelv med rotasjon og tilgangslogg',
        'Konfigurasjon per miljø, validert mot skjema',
        'Funksjonsbrytere per virksomhet',
        'Plugin-manifest sier hvilke hemmeligheter en plugin får',
      ],
      status: 'delvis',
    },
    {
      id: 'nettverk',
      name: 'Nettverk og sikkerhet',
      tagline: 'TLS overalt, minst mulig åpent, skannet kontinuerlig',
      description:
        'Trafikk inn går gjennom en ingress med TLS og brannmur for webapplikasjoner. Internt styrer nettverkspolicyer hvem som kan snakke med hvem, og en egress-guard sørger for at plugins bare når vertene manifestet tillater. Avhengigheter og images skannes for sårbarheter.',
      capabilities: [
        'Ingress med TLS og WAF',
        'Nettverkspolicyer mellom komponenter',
        'Egress-kontroll for plugins, verktøy og agentenes sandkasser',
        'Sårbarhetsskanning av kode, avhengigheter og images',
        'Låst testmiljø med godkjente klienter',
      ],
      status: 'delvis',
    },
    {
      id: 'jobber',
      name: 'Jobber, kø og hendelser',
      tagline: 'Varige jobber som overlever restart og prøver på nytt',
      description:
        'Innhenting, evalueringer og bruksavlesning er langvarige jobber som kjører i workeren fra en varig kø. Jobber kan prøves på nytt, parkeres ved vedvarende feil og følges i konsollet. Hendelser fra oppgaver kan abonneres på av andre systemer.',
      capabilities: [
        'Varig kø med retry og dead-letter',
        'Planlagte og hendelsesdrevne jobber',
        'Status og framdrift i konsollet',
        'Hendelser ut til andre systemer',
      ],
      status: 'bygd',
    },
    {
      id: 'tenant',
      name: 'Flerleietaker og residens',
      tagline: 'Én plattform, mange virksomheter, strengt adskilt',
      description:
        'Hver virksomhet er en tenant nøklet på organisasjonsnummer. Data, nøkler, kvoter og konfigurasjon er adskilt, og plattformen kan kjøres i flere regioner for virksomheter med særskilte residenskrav.',
      capabilities: [
        'Tenant per organisasjonsnummer',
        'Kvoter og budsjett per tenant',
        'Regionvalg for residenskrav',
        'Kostnad per tenant for fakturering',
      ],
      status: 'delvis',
    },
  ],

  /* ---------------------------------------------------------------- Agentisk rammeverk */
  'agent-runtime': [
    {
      id: 'oppgaver',
      name: 'Oppgaver og hendelseslogg',
      tagline: 'Hvert kall er en oppgave med uforanderlig logg',
      description:
        'Kjernen gjør hvert kall til en oppgave med en append-only logg over alt som skjer: søk, modellkall, verktøy, guardrails, tilbakemelding. Loggen er grunnlaget for sporing, evaluering, gjenopptak etter feil og revisjon.',
      capabilities: [
        'Oppgave per kall med append-only hendelser',
        'Idempotente kall og gjenopptak',
        'Kobling til bruker, organisasjon, tjeneste og versjon',
        'Kvote- og budsjettsjekk før kjøring',
      ],
      status: 'bygd',
    },
    {
      id: 'arbeidsmater',
      name: 'Arbeidsmåter',
      tagline: 'Enkeltkall, søk og svar, agentløkke, stegflyt eller egen motor',
      description:
        'Kjernen er paradigmenøytral: en arbeidsmåte er en plugin som bestemmer hvordan oppgaven løses. Enkle tjenester bruker ett modellkall, kunnskapstjenester søker først, agenter planlegger og bruker verktøy i løkke, og prosesser kjøres som stegflyt. Egen logikk kan kobles på som fjernagent.',
      capabilities: [
        'single-call, rag-single-shot, agent-loop, step-flow og remote',
        'Grenser for antall steg, tid og tokens per oppgave',
        'Parallelle verktøykall',
        'Egen motor via A2A uten endring i plattformen',
      ],
      options: [
        'Enkeltkall for omskriving og klassifisering',
        'Søk og svar for kunnskapstjenester',
        'Agentløkke når oppgaven krever planlegging',
        'Stegflyt for faste prosesser med godkjenning',
      ],
      status: 'bygd',
    },
    {
      id: 'minne',
      name: 'Minne og kontekst',
      tagline: 'Samtalehistorikk, kontekstbudsjett og komprimering',
      description:
        'Samtaler lagres som tråder, og kjernen bygger konteksten til hvert kall innenfor et tokenbudsjett: systeminstruks, historikk, kilder og verktøyresultater. Lange samtaler komprimeres, og langtidsminne per bruker eller tjeneste kan slås på der det er tillatt.',
      capabilities: [
        'Samtaletråder med historikk',
        'Kontekstbudsjett og prioritering',
        'Komprimering av lange samtaler',
        'Langtidsminne som opt-in med sletting',
      ],
      status: 'delvis',
    },
    {
      id: 'guardrails',
      name: 'Guardrails',
      tagline: 'Sjekker på vei inn og ut, før noe når modellen eller brukeren',
      description:
        'Guardrails kjører på inndata (persondata, forsøk på å omgå instruksjoner, tema utenfor tjenesten) og på utdata (skadelig innhold, fakta uten kilde, format). De konfigureres per tjeneste etter risikoklasse, og alt som stoppes logges på oppgaven.',
      capabilities: [
        'Inndata: persondata, prompt-injeksjon, tema',
        'Utdata: skadelig innhold, kildekrav, format og lengde',
        'KI-merking av alle svar',
        'Konfigurert per tjeneste etter risikoklasse',
      ],
      status: 'bygd',
    },
    {
      id: 'hooks',
      name: 'Hooks og utvidelser',
      tagline: 'Definerte punkter der egen logikk kan gripe inn',
      description:
        'Før og etter søk, modellkall og verktøykall, og ved fullført oppgave, kan en virksomhet koble på egen logikk: berike spørsmålet, filtrere treff, legge til kontroller. Utvidelser er pakker bak faste kontrakter og testes ved registrering.',
      capabilities: [
        'Hooks før og etter søk, modell og verktøy',
        'Utvidelser som pakker med manifest',
        'Kontrakttester ved registrering',
        'Egen logikk uten fork av plattformen',
      ],
      status: 'bygd',
    },
    {
      id: 'sandkasse',
      name: 'Sandkasse',
      tagline: 'Agenten kjører inne i en grense, og alt som går ut sjekkes mot policy',
      description:
        'En sandkasse er et isolert kjøremiljø der agentens prosesser, verktøykall og kodekjøring foregår. Filsystem, prosesser og nettverk er låst ned på kjernenivå, og alt som skal ut, DNS, nettverksforbindelser, nøkler, går via en tillitsside utenfor grensen som tar policybeslutningene. Agenten ser aldri ekte legitimasjon: den får en plassholder, og den ekte nøkkelen settes inn bare mot godkjente endepunkter. NVIDIA OpenShell er et åpent (Apache 2.0) eksempel på en slik kjøretid, og referansearkitekturen rundt den beskriver det samme som Genki: harness, verktøy og kunnskap i sandkassen, modellene utenfor.',
      capabilities: [
        'Isolert filsystem, prosess og nettverk per oppgave, håndhevet i kjernen',
        'Policy i YAML for filer, prosesser, nettverk og API-kall, med endringer i nettverkspolicy uten omstart',
        'Legitimasjon settes inn utenfor sandkassen, bare mot godkjente endepunkter',
        'Alt som går ut logges, og agenten kan fryses eller settes i karantene',
        'Formell sjekk av foreslåtte policyendringer før en person godkjenner dem',
        'Kjører på containere, mikro-VM eller Kubernetes på applikasjonsplattformen',
      ],
      options: [
        'Sandkasse per oppgave, kastes etter bruk',
        'Sandkasse per tjeneste med varig arbeidsområde',
        'Egen harness i sandkassen, koblet på som fjernagent',
      ],
      practices: [
        'La sandkassen eie verktøykallene, ikke bare kodekjøringen',
        'Start med nekt-alt for nettverk, og åpne per endepunkt',
        'Nye nettverksregler agenten ber om går alltid gjennom menneskelig godkjenning',
      ],
      status: 'planlagt',
    },
    {
      id: 'menneske',
      name: 'Menneske i løkken',
      tagline: 'Pause, godkjenning og overtakelse',
      description:
        'En stegflyt kan stoppe og vente på at en person godkjenner, endrer eller avviser før neste steg. Resultater kan leveres som utkast i fagsystemet, og en samtale kan overtas av en ansatt når KI-tjenesten ikke strekker til.',
      capabilities: [
        'Godkjenningssteg i stegflyt',
        'Utkast i stedet for handling',
        'Overtakelse av samtale',
        'Frister og eskalering',
      ],
      status: 'planlagt',
    },
    {
      id: 'streaming',
      name: 'Streaming og avbrudd',
      tagline: 'Svar som kommer mens de lages, og kan stoppes',
      description:
        'Svar strømmes til klienten token for token, med hendelser for søk, verktøykall og kilder underveis, så brukergrensesnittet kan vise hva som skjer. Brukeren kan avbryte, og kjernen rydder opp og logger det.',
      capabilities: [
        'Streaming av tokens og hendelser',
        'Avbrudd fra klienten',
        'Delresultater ved timeout',
      ],
      status: 'bygd',
    },
  ],

  /* ---------------------------------------------------------------- Verktøy */
  verktoy: [
    {
      id: 'mcp',
      name: 'MCP-verktøy',
      tagline: 'Koble på enhver MCP-server som verktøy',
      description:
        'Model Context Protocol er standarden for å gi modeller verktøy. En MCP-server registreres med manifest, verktøyene oppdages automatisk og kan velges per tjeneste. Autentisering mot serveren håndteres av plattformen.',
      capabilities: [
        'Registrering av MCP-servere med manifest',
        'Automatisk oppdagelse av verktøy',
        'Utvalg av verktøy per tjeneste',
        'Autentisering og egress-kontroll',
      ],
      status: 'bygd',
    },
    {
      id: 'openapi',
      name: 'OpenAPI-verktøy',
      tagline: 'Eksisterende API-er blir verktøy uten ny kode',
      description:
        'Et API med OpenAPI-spesifikasjon kan gjøres til verktøy direkte: operasjonene blir funksjoner modellen kan kalle, med parametre og beskrivelser fra spesifikasjonen. En allow-liste bestemmer hvilke operasjoner som eksponeres.',
      capabilities: [
        'Verktøy generert fra OpenAPI 3',
        'Allow-liste per operasjon',
        'Autentisering med Maskinporten eller nøkkel',
        'Validering av parametre før kall',
      ],
      status: 'bygd',
    },
    {
      id: 'a2a',
      name: 'Fjernagenter (A2A)',
      tagline: 'La en annen agent gjøre deloppgaven',
      description:
        'Agent-to-Agent-protokollen lar en tjeneste delegere til en agent som kjører et annet sted, for eksempel i virksomhetens egen plattform. Agentkortet beskriver hva den kan, og kjernen følger oppgaven til den er ferdig.',
      capabilities: [
        'Agentkort og oppdagelse',
        'Delegering med oppfølging av status',
        'KI-tjenester eksponert som A2A-agenter',
        'Egen motor koblet på som fjernagent',
      ],
      status: 'bygd',
    },
    {
      id: 'skills',
      name: 'Skills',
      tagline: 'Gjenbrukbare instruksjoner og prosedyrer',
      description:
        'En skill er en pakke med instruksjoner, eksempler og eventuelt verktøy som gir modellen en ferdighet, for eksempel å skrive klarspråk eller følge en saksbehandlingsrutine. Skills følger Agent Skills-formatet og kan deles mellom virksomheter.',
      capabilities: [
        'Agent Skills-formatet',
        'Lastes per tjeneste eller variant',
        'Delte skills i katalogen',
        'Versjonert med tjenesten',
      ],
      status: 'bygd',
    },
    {
      id: 'innebygd',
      name: 'Innebygde verktøy',
      tagline: 'Søk, dato, beregning og kodekjøring i sandkasse',
      description:
        'Noen verktøy trengs av de fleste: søk i egne datasett, dagens dato, utregning, henting av en nettside og kjøring av kode i en isolert sandkasse. De er innebygd og kan slås på per tjeneste.',
      capabilities: [
        'Datasett-søk som verktøy',
        'Dato, beregning og enhetskonvertering',
        'Henting av nettsider med allow-liste',
        'Kodekjøring i sandkassen til det agentiske rammeverket, med tidsgrense',
      ],
      status: 'delvis',
    },
    {
      id: 'katalog',
      name: 'Katalog og godkjenning',
      tagline: 'Hvilke verktøy finnes, og hvem har godkjent dem',
      description:
        'Alle verktøy ligger i en katalog per virksomhet, med manifest som sier hvilke verter og hemmeligheter de får bruke. Der policy krever det, må Digdir godkjenne før et verktøy kan brukes i en publisert tjeneste. Kontrakttester kjøres ved registrering.',
      capabilities: [
        'Katalog per virksomhet, delte verktøy på tvers',
        'Manifest med tillatte verter og hemmeligheter',
        'Godkjenning der policy krever det',
        'Kontrakttester ved registrering',
        'Logg på hvert verktøykall',
      ],
      status: 'bygd',
    },
  ],

  /* ---------------------------------------------------------------- KI-tjenester */
  definisjoner: [
    {
      id: 'definisjon',
      name: 'Tjenestedefinisjon',
      tagline:
        'Alt om tjenesten på ett sted: formål, data, modell, tilgang, kanaler, budsjett og kvalitetskrav',
      description:
        'Én definisjon i YAML eller i portalen er hele sannheten om en tjeneste. Alt som styrer hvordan den oppfører seg og hvem som får bruke den, står der, og ingenting publiseres før definisjonen er validert og publiseringsportene er bestått. Portene er testsettene som må kjøres og tersklene dommerne må nå for en ny versjon.',
      capabilities: [
        'YAML med skjema, eller skjema i portalen',
        'Formål, målgruppe, risikoklasse og språkinstruksjoner',
        'Datasett, verktøy, skills, modell og arbeidsmåte, med dataresidens',
        'Tilgang: ressurs i Ressursregisteret, rettigheter i Altinn, nøkler og systembrukere',
        'Kanaler: arbeidsflate, API, MCP, A2A, og om tjenesten er åpen for anonyme',
        'Budsjett og kvoter per tjeneste, kanal og organisasjon',
        'Guardrails på inn- og utdata etter risikoklasse, krav til kilder og KI-merking',
        'Publiseringsporter: testsett og terskler som må bestås',
        'Validering mot skjema og katalogene ved publisering',
      ],
      status: 'bygd',
    },
    {
      id: 'varianter',
      name: 'Varianter',
      tagline: 'Samme tjeneste med annen modell, språk eller flyt',
      description:
        'En tjeneste kan ha varianter: nynorsk i stedet for bokmål, en raskere modell, bare søk uten generering, eller en spesialisert stegflyt. Hver variant har egen arbeidsmåte og kan velges av klienten eller styres av regler.',
      capabilities: [
        'Varianter med egen modell, instruks og arbeidsmåte',
        'Språkvarianter',
        'Valg fra klient eller etter regel',
        'Ett MCP-verktøy per variant',
      ],
      status: 'bygd',
    },
    {
      id: 'versjoner',
      name: 'Versjoner og publisering',
      tagline: 'Utkast påvirker aldri brukerne, publisering går gjennom porter',
      description:
        'Alle endringer skjer i et utkast. Publisering krever begrunnelse, kjører publiseringsportene og lager en ny versjon med full revisjonslogg. En tidligere versjon kan gjenopprettes på sekunder.',
      capabilities: [
        'Utkast og publisert versjon',
        'Publiseringsporter fra kvalitetslaget',
        'Begrunnelse og revisjonslogg',
        'Tilbakerulling',
      ],
      status: 'bygd',
    },
    {
      id: 'instruksjoner',
      name: 'Instruksjoner',
      tagline: 'Systeminstruks, eksempler og variabler',
      description:
        'Instruksjonene forteller modellen hvordan den skal oppføre seg: rolle, tone, hva den ikke skal gjøre, hvordan kilder skal brukes. Maler med variabler gjør det mulig å dele gode instruksjoner mellom tjenester og tilpasse dem per virksomhet.',
      capabilities: [
        'Systeminstruks med maler og variabler',
        'Eksempler (few-shot)',
        'Delte maler i katalogen',
        'Versjonert med tjenesten',
      ],
      status: 'bygd',
    },
    {
      id: 'portal',
      name: 'Portalen',
      tagline: 'Bygg, test og publiser, med en assistent som hjelper',
      description:
        'Portalen har en enkel visning for fagfolk og en utviklervisning med YAML. Byggeassistenten fyller ut definisjonen i samtale og foreslår endringer, men en person godkjenner alltid. Playground viser resultatet før publisering.',
      capabilities: [
        'Enkel visning og utviklervisning',
        'Byggeassistent som foreslår, person som godkjenner',
        'Playground og testsett fra portalen',
        'Maler for vanlige tjenestetyper',
      ],
      status: 'bygd',
    },
    {
      id: 'maler',
      name: 'Maler og deling',
      tagline: 'Kopier en tjeneste fra en annen virksomhet og tilpass',
      description:
        'Tjenester som Kunnskapsassistenten, Klarspråk og Nynorsk ligger som maler. En virksomhet kopierer malen, bytter datasett og instruksjoner, og har en egen tjeneste på minutter. Forbedringer kan deles tilbake.',
      capabilities: [
        'Maler for vanlige tjenester',
        'Kopier og tilpass',
        'Del tilbake til fellesskapet',
        'Katalog over publiserte tjenester på tvers',
      ],
      status: 'delvis',
    },
  ],

  /* ---------------------------------------------------------------- Brukergrensesnitt */
  kanaler: [
    {
      id: 'arbeidsflate',
      name: 'Arbeidsflate',
      tagline: 'Ferdig chat-klient der ansatte bruker tjenestene',
      description:
        'En ferdig webapp der ansatte finner virksomhetens tjenester, stiller spørsmål, ser kilder og gir tilbakemelding. Krever ingen utvikling hos virksomheten og får nye tjenester automatisk når de publiseres.',
      capabilities: [
        'Tjenestekatalog per virksomhet',
        'Samtaler med kilder og streaming',
        'Tilbakemelding per svar',
        'Filopplasting der tjenesten tillater det',
      ],
      status: 'bygd',
    },
    {
      id: 'komponenter',
      name: 'KI-komponenter',
      tagline: 'Gjenbrukbare komponenter for egne frontender',
      description:
        'Komponenter for chat, kilder, tilbakemelding og streaming, bygd på Designsystemet, som kan settes inn i virksomhetens egne nettsider og fagsystemer. Frontend-kontrakten beskriver inn- og utdata som JSON Schema.',
      capabilities: [
        'Chat-, kilde- og tilbakemeldingskomponenter',
        'Bygd på Designsystemet',
        'Frontend-kontrakt med JSON Schema',
        'Universell utforming',
      ],
      status: 'delvis',
    },
    {
      id: 'openai-api',
      name: 'OpenAI-kompatibelt API',
      tagline: 'Bruk Genki fra ethvert verktøy som snakker OpenAI',
      description:
        'Tjenestene eksponeres som modeller på et OpenAI-kompatibelt endepunkt. Dermed kan eksisterende verktøy, biblioteker og KI-assistenter bruke en KI-tjeneste ved å bytte URL og nøkkel.',
      capabilities: [
        'GET /v1/models og POST /v1/chat/completions',
        'Streaming',
        'Tjeneste og variant som modellnavn',
        'Nøkkel med principal',
      ],
      status: 'bygd',
    },
    {
      id: 'mcp-a2a',
      name: 'Genki som verktøy for andre',
      tagline: 'Tjenestene eksponert over MCP og A2A, så andre agenter og systemer kan bruke dem',
      description:
        'Hver variant kan eksponeres som et MCP-verktøy og hver tjeneste som en A2A-agent. Da kan andre agenter, assistenter og fagsystemer bruke KI-tjenestene maskinelt, med samme tilgangsstyring som ellers.',
      capabilities: [
        'MCP: ett verktøy per variant',
        'A2A: agentkort og oppgaver',
        'Samme identitet og rettigheter som i andre kanaler',
      ],
      status: 'bygd',
    },
    {
      id: 'rest',
      name: 'REST-API',
      tagline: 'Datasett, samtaler, fasetter og tilbakemelding',
      description:
        'Et REST-API for alt rundt samtalen: administrere datasett, hente fasetter, liste samtaler og sende tilbakemelding. Det samme API-et portalen og konsollet bruker.',
      capabilities: [
        'Datasett og innhenting',
        'Samtaler og historikk',
        'Fasetter og filtre',
        'Tilbakemelding og skårer',
      ],
      status: 'bygd',
    },
    {
      id: 'portal-konsoll',
      name: 'Portal og konsoll',
      tagline: 'Der virksomheter bygger, og Digdir drifter',
      description:
        'Portalen er virksomhetens arbeidsplass: tjenester, datasett, testsett, nøkler og forbruk. Konsollet er Digdirs: godkjenne organisasjoner, modeller, priser og drift. Begge er klienter av samme API.',
      capabilities: [
        'Portal for virksomheter',
        'Konsoll for operatører',
        'Alt tilgjengelig i API-et',
      ],
      status: 'bygd',
    },
  ],
};

export const componentsFor = (blockId: string): Component[] => componentsByBlock[blockId] ?? [];

export const componentById = (blockId: string, id: string): Component | undefined =>
  componentsFor(blockId).find((c) => c.id === id);
