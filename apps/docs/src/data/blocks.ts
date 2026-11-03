export type BlockColor =
  'accent' | 'brand1' | 'brand2' | 'brand3' | 'neutral' | 'info' | 'success' | 'warning';
export type Status = 'bygd' | 'delvis';

export type Adr = { id: string; title: string };

export type Block = {
  id: string;
  name: string;
  tagline: string;
  color: BlockColor;
  status: Status;
  description: string[];
  capabilities: string[];
  packages: string[];
  adrs: Adr[];
  reuse: string;
};

export const ADR_BASE = 'https://github.com/digdir/genki/blob/main/docs/adr/';

export const blocks: Block[] = [
  // Rekkefølgen følger figuren: pilarene til venstre, stacken, så gateway, modeller og infrastruktur.
  {
    id: 'autentisering',
    name: 'Autentisering',
    tagline:
      'ID-porten, Ansattporten og Maskinporten: nasjonale fellesløsninger i stedet for egen brukerbase',
    color: 'warning',
    status: 'bygd',
    description: [
      'Ingen egen brukerdatabase. Innbyggere logger inn med ID-porten, ansatte med Ansattporten gjennom sin egen virksomhets identitetsleverandør, og systemer bruker Maskinporten med virksomhetssertifikat. Digdirs operatører logger inn med Entra ID.',
      'Alle påloggingene ender i samme principal-modell: hvert kall vet hvem det handler på vegne av og for hvilken organisasjon. For klienter som ikke kan bruke Maskinporten utsteder portalen API-nøkler som bærer en principal.',
      'Lokalt er fellesløsningene mocket, med testpersoner som Kari Testansatt og Hensynsløs Måke, så alle kan kjøre plattformen uten avtaler.',
    ],
    capabilities: [
      'ID-porten for innbyggere, Ansattporten for ansatte, Maskinporten for systemer',
      'Én principal-modell uansett kanal',
      'API-nøkler med principal og policy',
      'Entra ID for Digdirs operatører',
      'Kortlevde tokens og utlogging mot fellesløsningen',
      'Mock-pålogging og testpersoner i utviklingsmodus',
    ],
    packages: ['identity', 'valuehash'],
    adrs: [
      { id: '0008', title: 'Principal model and the API-key bridge' },
      { id: '0035', title: 'Operator login' },
    ],
    reuse:
      'Pålogging kommer fra fellesløsningene virksomhetene allerede bruker. Ingen ny brukerbase, ingen nye passord.',
  },
  {
    id: 'tilgangsstyring',
    name: 'Tilgangsstyring',
    tagline:
      'Altinn Autorisasjon og Ressursregisteret: hvem har rett til hva, på vegne av hvilken virksomhet',
    color: 'warning',
    status: 'bygd',
    description: [
      'Rettigheter hentes fra Altinn Autorisasjon for hver organisasjon, basert på roller fra Enhetsregisteret og delegeringer virksomheten selv har gjort. KI-tjenester registreres som ressurser i Ressursregisteret, så virksomheten styrer tilgang med de samme verktøyene som for andre offentlige tjenester.',
      'Inne i plattformen er rettighetene eksplisitte: å administrere tjenester, datasett, tilgang og forbruk er hver sin rett, og de kan delegeres. Tilgang til data håndheves helt ned på dokumentnivå i søket, og tenant-isolasjon i databasen sikrer at ingen spørring krysser organisasjonsgrenser.',
      'Hver tilgangsbeslutning logges, så det alltid går an å svare på hvem som brukte hva, når og på vegne av hvem.',
    ],
    capabilities: [
      'Rettigheter fra Altinn Autorisasjon per organisasjon',
      'KI-tjenester som ressurser i Ressursregisteret',
      'Tilgangspakker, roller og systembrukere',
      'Plattformrettigheter som kan delegeres',
      'Tilgang på datasett- og dokumentnivå, filtrert før rangering',
      'Beslutningslogg og revisjon',
    ],
    packages: ['identity'],
    adrs: [
      { id: '0027', title: 'Platform rights' },
      { id: '0036', title: 'Delegating platform rights' },
    ],
    reuse:
      'Rettighetene finnes allerede i Altinn. Plattformen spør, i stedet for å bygge sin egen tilgangsmodell.',
  },
  {
    id: 'kanaler',
    name: 'Brukergrensesnitt',
    tagline:
      'Veiene inn: der mennesker og systemer bruker tjenestene, i arbeidsflaten, egne frontender eller over API, MCP og A2A',
    color: 'brand1',
    status: 'bygd',
    description: [
      'Dette er veiene inn til Genki, for mennesker og for systemer. Verktøyene Genki selv bruker når agentene skal gjøre noe, ligger under Verktøy. Plattformen er headless. Hver kanal oversetter sin protokoll til samme type forespørsel, så en tjeneste oppfører seg likt enten den kalles fra et chatverktøy, en agent eller en integrasjon.',
      'Tre webapper bruker API-et: arbeidsflaten der ansatte bruker tjenestene, portalen der virksomheter bygger, tester og publiserer, og konsollet der Digdir drifter plattformen. Egne frontender bygges fra publiserte skjemaer: to ble bygd fra kontrakten alene, uten tilgang til koden.',
    ],
    capabilities: [
      'OpenAI-kompatibel: GET /v1/models og POST /v1/chat/completions',
      'MCP: POST /api/mcp, ett verktøy per variant',
      'A2A: agentkort og POST /a2a/:agent',
      'REST: datasett, fasetter, samtaler og tilbakemelding',
      'Arbeidsflate, portal og konsoll som ferdige klienter',
      'Input-skjema og output som JSON Schema for egne frontender',
    ],
    packages: [
      'adapter-openai',
      'adapter-mcp',
      'adapter-a2a',
      'adapter-rest',
      'client',
      'apps/workspace',
      'apps/portal',
      'apps/console',
    ],
    adrs: [
      { id: '0030', title: 'Frontends from schemas' },
      { id: '0032', title: 'The portal is one client' },
    ],
    reuse:
      'Et verktøy som allerede snakker OpenAI, MCP eller A2A kan bruke en KI-tjeneste på Genki i dag, uten integrasjonsarbeid.',
  },
  {
    id: 'definisjoner',
    name: 'KI-tjenester',
    tagline:
      'En KI-tjeneste beskrives i én definisjon: formål, data, modell, tilgang, kanaler og budsjett, versjonert og publisert etter kvalitetssjekk',
    color: 'info',
    status: 'bygd',
    description: [
      'En tjeneste beskrives i en kort definisjon: hva den er for, hvilke dokumenter den kan søke i, hvilken modell som svarer og hvor folk når den. Definisjonen er versjonert konfigurasjon, og hver endring er revidert med hvem og hvorfor.',
      'En tjeneste kan ha varianter: en raskere modell, bare søk, en spesialisert flyt. Hver variant har en arbeidsmåte, enten en ferdig strategi med innstillinger eller en stegflyt. Portalen viser arbeidsmåten som enkle steg, så en tjenesteeier ser hva den gjør uten å lese konfigurasjon.',
      'Publisering sjekker definisjonen mot katalogene: ukjente modeller, modell utenfor dataresidens, ugyldig strategikonfigurasjon og duplikate navn avvises. Hver publisert versjon beholdes.',
    ],
    capabilities: [
      'Definisjoner i YAML eller portalen, med skjema',
      'Varianter av samme tjeneste med egen modell eller flyt',
      'Versjonering med begrunnelse og full revisjonslogg',
      'Risikoklasse, målgruppe og språkinstruksjoner per tjeneste',
      'Byggeassistent som fyller ut definisjonen i samtale',
      'Enkel visning og utviklervisning i samme portal',
    ],
    packages: ['definitions', 'contracts', 'schema-forms', 'composition', 'i18n'],
    adrs: [
      { id: '0031', title: 'Services, variants and ways of working' },
      { id: '0007', title: 'Paradigm-neutral service definition' },
      { id: '0005', title: 'Definition store authority' },
      { id: '0037', title: 'Simple and developer view in the portal' },
    ],
    reuse:
      'En tjeneste bygd i én virksomhet er en definisjon som kan deles, kopieres og tilpasses av en annen.',
  },
  {
    id: 'agent-runtime',
    name: 'Agentisk rammeverk',
    tagline: 'Kjernen som kjører hvert kall som en oppgave med logg, budsjett og guardrails',
    color: 'accent',
    status: 'bygd',
    description: [
      'Kjernen er paradigmenøytral. Den vet ikke om en tjeneste er et enkelt modellkall, et søk-og-svar, en agentløkke med verktøy eller en stegflyt. Hvert kall blir en oppgave (task) med en append-only logg, og tilgang, kvoter og budsjetter håndheves ett sted.',
      'Arbeidsmåter (strategier) er plugins: single-call, rag-single-shot, agent-loop, step-flow og remote. En agentløkke planlegger, søker, leser kilder, sjekker dem og svarer, innenfor et budsjett for antall søk og lesinger. Egen logikk kjører utenfor plattformen som en fjernagent, en verktøykilde eller et hook-endepunkt.',
      'Hooks gir definerte punkter i en kjøring: før og etter søk, før og etter modellkall, før og etter verktøykall, ved fullført oppgave, ved publisering og ved tilbakemelding. Guardrails sjekker inn- og utdata.',
    ],
    capabilities: [
      'Oppgaver med append-only logg, sporbare fra spørsmål til svar',
      'Kvoter og budsjetter per tjeneste og organisasjon',
      'Arbeidsmåter: enkeltkall, søk og svar, agentløkke, stegflyt, egen motor',
      'Hooks før og etter søk, modellkall og verktøykall',
      'Guardrails på inn- og utdata',
      'Sandkasse for agentens prosesser og verktøykall',
      'Byggeassistent som foreslår endringer, en person godkjenner',
    ],
    packages: [
      'kernel',
      'strategy-agent-loop',
      'strategy-rag',
      'strategy-step-flow',
      'strategy-remote',
      'strategy-single-call',
      'hooks',
      'guardrails',
      'jobs',
    ],
    adrs: [
      { id: '0002', title: 'A paradigm-neutral kernel' },
      { id: '0023', title: 'Extension model' },
      { id: '0028', title: 'Custom logic comes from outside' },
      { id: '0020', title: 'Changes made by AI' },
    ],
    reuse:
      'Samme runtime kjører alle tjenester, så en ny arbeidsmåte eller et nytt verktøy blir tilgjengelig for alle virksomheter samtidig.',
  },
  {
    id: 'rag',
    name: 'Kunnskap',
    tagline:
      'Virksomhetens egne data, gjort søkbare med RAG: datasett, innhenting, søk og reranking, med nummererte kilder i svaret',
    color: 'brand2',
    status: 'bygd',
    description: [
      'En virksomhet legger til sine data som datasett. Innhenting (ingest) henter dokumenter fra filer, Parquet, Postgres, HTTP eller MCP, deler dem i biter, lager embeddings og skriver til en søkemotor. PDF-er gjøres om til Markdown med Marker.',
      'Søket er leverandørnøytralt bak en port. Typesense og Postgres med pgvector er innebygd, og en ColBERT-reranker velger de beste kildene før modellen svarer. Hvert svar er merket som laget med KI og har nummererte kilder.',
      'Kunnskapsassistenten, som svarer med kilder fra offentlige rapporter i Kudos, er eksempeltjenesten. Den er definert som alle andre tjenester, i konfigurasjon.',
    ],
    capabilities: [
      'Datasett på Typesense, pgvector, Postgres, HTTP eller MCP',
      'Innhenting fra filer, Parquet, Postgres og MCP, med PDF til Markdown',
      'Chunking, embeddings og fasetter',
      'Reranking med ColBERT',
      'Nummererte kilder i svaret og i API-et',
      'Bytt søkemotor i konfigurasjon, ikke kode',
    ],
    packages: [
      'retrieval',
      'ingest',
      'port-knowledge',
      'port-embedding',
      'port-rerank',
      'providers-typesense',
      'providers-pgvector',
      'providers-colbert',
      'providers-documents',
    ],
    adrs: [
      { id: '0025', title: 'Search engine switching' },
      { id: '0017', title: 'Parity scope and intentional divergences' },
    ],
    reuse:
      'Hver virksomhet kobler egne kilder på, og får søk, reranking og kildehenvisning uten å bygge en RAG-pipeline selv.',
  },
  {
    id: 'verktoy',
    name: 'Verktøy',
    tagline:
      'Veiene ut: det agentene kan slå opp i og gjøre, fra MCP-servere, API-er, andre agenter og skills',
    color: 'brand3',
    status: 'bygd',
    description: [
      'Dette er veiene ut fra agentene: det de kan slå opp i og gjøre, det som på engelsk kalles tools og tool calling. Hvordan andre bruker KI-tjenestene som verktøy, ligger under Brukergrensesnitt. Åpne protokoller er innebygd. Alt som snakker MCP, OpenAPI eller A2A kan kobles på som verktøy uten endring i plattformen. En virksomhet registrerer en verktøytilkobling med egne hemmeligheter, og Digdir kan løfte den til den delte katalogen.',
      'Skills følger Agent Skills-formatet og er en egen definisjonstype. En tjeneste kan laste skills som gir modellen instruksjoner og prosedyrer, og en agentløkke tar lastede skills med inn i svaret.',
      'Hver plugin har et manifest som sier hvilke verter og hemmeligheter den får bruke. En egress-guard håndhever det på hvert kall.',
    ],
    capabilities: [
      'Verktøy fra MCP-servere, OpenAPI-spesifikasjoner og A2A-agenter',
      'Skills i Agent Skills-formatet',
      'Katalog over byggeklosser per virksomhet, med Digdir-godkjenning der policy krever det',
      'Manifest med tillatte verter og hemmeligheter, håndhevet av egress-guard',
      'Kontrakttester kjøres ved registrering, en plugin som feiler avvises',
    ],
    packages: [
      'port-tools',
      'providers-mcp-client',
      'providers-openapi-tools',
      'providers-a2a-client',
      'plugins',
    ],
    adrs: [
      { id: '0023', title: 'Extension model' },
      { id: '0024', title: 'Skills as a definition kind' },
      { id: '0015', title: 'Tenant-provided tools and secrets' },
    ],
    reuse:
      'Et verktøy registrert én gang kan brukes av tjenester i alle virksomheter, mens det fortsatt kjører med eierens tilkobling.',
  },
  {
    id: 'evals',
    name: 'Kvalitet',
    tagline: 'Testsett, dommere og publiseringsporter, så kvalitet måles før noe når brukerne',
    color: 'success',
    status: 'bygd',
    description: [
      'Evaluering er en del av plattformen, ikke et verktøy ved siden av. En evalueringskjøring er en oppgave som kaller tjenesten for hver testcase, som enhver annen bruker. Evaluatorer er plugins: deterministiske, modellbaserte eller menneskelige.',
      'Testsett eies av virksomheten og er versjonert, med cases delt i train, validation og locked. Publiseringsporter ligger i tjenestedefinisjonen: en versjon med en feilende port kan ikke publiseres til produksjon. Hvert resultat husker kodeversjon, data, modell og dommer, så likt sammenlignes med likt.',
      'Parity-harnesset sammenligner svar med digdir-headless-rag. Sporing går til Langfuse etter OpenTelemetry GenAI-konvensjonene, og playground i portalen lar en tjenesteeier prøve en variant før publisering.',
    ],
    capabilities: [
      'Versjonerte testsett med train, validation og locked split',
      'Dommere: deterministiske, LLM-as-judge forankret i kilder, menneskelige',
      'Publiseringsporter i tjenestedefinisjonen',
      'Parity-harness mot eksisterende løsninger',
      'Sporing i Langfuse (OpenTelemetry GenAI)',
      'Playground og byggeassistent i portalen',
    ],
    packages: ['eval', 'providers-langfuse', 'apps/parity', 'strategy-builder'],
    adrs: [
      { id: '0003', title: 'Evaluation is part of the platform' },
      { id: '0026', title: 'Builder assistant and proposals' },
    ],
    reuse:
      'En felles evalueringsmotor gjør at alle virksomheter måler kvalitet likt, og at en ny modell kan testes mot alle tjenester før bytte.',
  },
  {
    id: 'plattform',
    name: 'Applikasjonsplattform',
    tagline: 'Digdirs applikasjonsplattform (DIS): der fellesløsningene kjører, Genki inkludert',
    color: 'neutral',
    status: 'delvis',
    description: [
      'Applikasjonsplattformen er Digdirs felles plattform for drift av fellesløsninger og tjenester, kalt DIS. Genki er én av applikasjonene som kjører der, side om side med andre fellesløsninger. Plattformen gir kjøremiljø, utrulling, logging, overvåking, lagring, hemmeligheter og nettverk, så Genki slipper å løse drift selv.',
      'For Genki betyr det at API og worker kjører som containere, Postgres er primærlager med row-level security per organisasjon, varige jobber kjører fra en kø, og alle admin-operasjoner har begrunnelse og revisjon. Infrastrukturen er beskrevet som kode og rulles ut gjennom pipeline.',
      'Dette er ikke det samme som infrastruktur for KI. Språkmodellene kjører hos Sigma2, Telenor AI Factory, i sky eller i egen drift, og nås gjennom KI-porten. Applikasjonsplattformen drifter applikasjonen, ikke modellene.',
    ],
    capabilities: [
      'Tenant-isolasjon med row-level security i Postgres',
      'API og worker i containere, infrastruktur som kode (Bicep)',
      'Varige jobber og kø',
      'Revisjonslogg for alle admin-operasjoner',
      'Oppbevaring, sletting og arkivering',
      'Låst testmiljø der bare konfigurerte klienter kan bruke modeller',
      'Felles drift med andre fellesløsninger på DIS',
    ],
    packages: ['apps/api', 'apps/worker', 'providers-postgres', 'infra/', 'jobs'],
    adrs: [
      { id: '0001', title: 'Foundations' },
      { id: '0022', title: 'Tenant isolation in Postgres' },
      { id: '0010', title: 'Admin operations and audit' },
      { id: '0011', title: 'Retention, erasure and archiving' },
      { id: '0033', title: 'Locked test environment' },
    ],
    reuse:
      'Én plattform for alle fellesløsninger: drift, sikkerhet, isolasjon og revisjon løses én gang på DIS, ikke i hvert prosjekt.',
  },
  {
    id: 'ki-gateway',
    name: 'KI-porten',
    tagline:
      'KI-gatewayen: én port til modellene for hele forvaltningen, med katalog, residens, kostnad og nøkler',
    color: 'brand1',
    status: 'delvis',
    description: [
      'KI-porten er modellrutingen i Genki, KI-gatewayen som alle tjenester går gjennom. Tjenestene velger en modell fra en katalog, og gatewayen vet hvor modellen kjører, hva den koster per token og hvilken dataresidens den har. En tjeneste kan ikke publiseres med en modell utenfor sin tillatte residens.',
      'Modeller nås gjennom protokolladaptere: OpenAI-kompatible API-er og Anthropic Messages. Dermed kan Azure AI Foundry (GPT og Claude), lokale modeller og norske modeller kobles på uten kodeendringer, bare konfigurasjon i models.yaml.',
      'Digdirs egen AI Gateway (prototypet i aivar-lab på agentgateway) foreslås som kilde for bruk, modell-liste og nøkler. Hver organisasjon får ett samlet forbruk, og gateway-nøkler med budsjett deles ut fra portalen i stedet for per e-post.',
    ],
    capabilities: [
      'Modellkatalog med kapabiliteter (streaming, verktøy, JSON-schema, resonnering)',
      'Dataresidens per modell (norway, eu, global) håndhevet ved publisering',
      'Kostnad per token og samlet forbruk per organisasjon',
      'Nøkler med budsjett for organisasjoner og tjenester',
      'Protokolladaptere: OpenAI-chat, OpenAI Responses, Anthropic Messages',
      'Automatisk oppdagelse av deployments i Azure AI Foundry',
    ],
    packages: [
      'port-model',
      'providers-openai',
      'providers-anthropic',
      'adapter-openai',
      'port-usage (foreslått)',
    ],
    adrs: [
      { id: '0021', title: 'Model access through protocol adapters' },
      { id: '0038', title: 'The AI Gateway as a usage source, key issuer and model route' },
    ],
    reuse:
      'Enhver virksomhet kan hente modeller via samme OpenAI-kompatible endepunkt, med forbruk og budsjett per organisasjon.',
  },
  {
    id: 'sprakmodeller',
    name: 'Språkmodeller',
    tagline: 'Store språkmodeller, åpne og kommersielle, tilgjengeliggjort gjennom KI-porten',
    color: 'brand1',
    status: 'delvis',
    description: [
      'Språkmodellene er motoren bak hver KI-tjeneste. Genki eier ingen modeller selv, men gjør dem tilgjengelige gjennom KI-porten: kommersielle frontier-modeller fra store leverandører, åpne vektmodeller som kan driftes i Norge, og norske modeller trent av Nasjonalbiblioteket og forskningsmiljøene.',
      'En tjeneste velger modell etter behov: en stor modell for krevende resonnering, en mindre og billigere for klassifisering, en norsk modell der språk og residens veier tyngst. Gatewayen vet hvor hver modell kjører og hva den koster, og håndhever residenskravet tjenesten har satt.',
      'Feltet beveger seg fort. Delene under henter derfor levende lister fra Hugging Face: modeller fra norske miljøer, åpne modeller folk faktisk bruker, embeddings og rerankere, og modeller for tale og syn, i tillegg til den kuraterte oversikten.',
    ],
    capabilities: [
      'Kommersielle frontier-modeller: Claude, GPT, Gemini',
      'Åpne vektmodeller: Llama, Qwen, DeepSeek, Gemma, Mistral, gpt-oss',
      'Norske modeller fra Nasjonalbiblioteket: Borealis, NB-Llama og Mímir-samarbeidet',
      'Embeddings-, reranking- og talemodeller',
      'Modellvalg per tjeneste og variant, innenfor residenskrav',
      'Levende oversikt fra Hugging Face',
    ],
    packages: ['providers-azure-foundry', 'providers-openai-compatible', 'providers-anthropic'],
    adrs: [
      { id: '0021', title: 'Model access through protocol adapters' },
      { id: '0038', title: 'The AI Gateway as a usage source, key issuer and model route' },
    ],
    reuse:
      'Modellene byttes i konfigurasjon. En tjeneste som fungerer med én modell kan prøves på en annen uten å endre kode.',
  },
  {
    id: 'ki-infrastruktur',
    name: 'Infrastruktur for KI',
    tagline: 'Der modellene kjører: Sigma2, Telenor AI Factory, sky eller egen drift',
    color: 'neutral',
    status: 'delvis',
    description: [
      'Infrastruktur for KI er regnekraften som kjører språkmodellene: GPU-er, lagring og nettverk dimensjonert for trening og inferens. Dette er noe annet enn applikasjonsplattformen, som drifter Genki og de andre fellesløsningene.',
      'Norge har flere alternativer. Sigma2 drifter den nasjonale superdatamaskinen Olivia for forskning og forvaltning. Telenor AI Factory tilbyr suveren kapasitet på Nvidia-GPU-er i norske datasentre. Skyleverandørene tilbyr modeller som tjeneste i EU-regioner, og Digdir eksperimenterer med egen drift av åpne modeller. Og listen er ikke lukket: norske datasentre som Stargate Norway, Green Mountain og Lefdal, europeiske neoclouds og de store skyene kan alle kobles på bak gatewayen.',
      'KI-porten gjør valget usynlig for tjenestene. Samme virtuelle modellnavn kan rutes til Sigma2 i dag og til egen drift i morgen, så lenge residenskravet holdes.',
    ],
    capabilities: [
      'Nasjonal regnekraft hos Sigma2 (Olivia)',
      'Suveren kapasitet hos Telenor AI Factory',
      'Modeller som tjeneste i sky med EU-residens',
      'Egen drift av åpne modeller hos Digdir',
      'Åpent for flere: norske datasentre, neoclouds og de store skyene',
      'Samme modellnavn uansett hvor modellen kjører',
    ],
    packages: ['providers-openai-compatible'],
    adrs: [{ id: '0021', title: 'Model access through protocol adapters' }],
    reuse:
      'Regnekraft kjøpes eller deles nasjonalt, ikke bygges per virksomhet. Gatewayen skjuler hvor modellen faktisk kjører.',
  },
];

export const blockById = (id: string) => blocks.find((b) => b.id === id);

/** Som blockById, for oppslag fra egne datafiler der id-en skal finnes. */
export const requireBlock = (id: string): Block => {
  const block = blockById(id);
  if (!block) throw new Error(`Ukjent overordnet byggekloss «${id}»`);
  return block;
};

/** Byggeklossene i alfabetisk rekkefølge, brukt i listen. Forrige/neste på detaljsidene følger figuren. */
export const blocksAlphabetical: Block[] = [...blocks].sort((a, b) =>
  a.name.localeCompare(b.name, 'nb'),
);

export type Model = {
  name: string;
  provider: string;
  residency: string;
  status: Status | 'planlagt';
};

export const models: Model[] = [
  {
    name: 'GPT-5 og GPT-4o',
    provider: 'Azure AI Foundry (OpenAI)',
    residency: 'global / eu',
    status: 'bygd',
  },
  {
    name: 'Claude',
    provider: 'Azure AI Foundry (Anthropic)',
    residency: 'global / eu',
    status: 'bygd',
  },
  {
    name: 'Lokal testmodell (echo)',
    provider: 'Kjører lokalt',
    residency: 'norway',
    status: 'bygd',
  },
  {
    name: 'Norske språkmodeller',
    provider: 'Nasjonal infrastruktur',
    residency: 'norway',
    status: 'planlagt',
  },
  {
    name: 'Egne modeller via OpenAI-kompatibelt API',
    provider: 'Hvilken som helst leverandør',
    residency: 'per endepunkt',
    status: 'bygd',
  },
];

export type FlowStep = {
  id: string;
  title: string;
  text: string;
  block: string;
  node: string;
};

/** En KI-tjeneste vist som case: hva den gjør, og stegene gjennom byggeklossene. Legg til flere her. */
export type Case = {
  id: string;
  name: string;
  intro: string;
  /** Bruk av tjenesten: hva som skjer fra noen spør til svaret kommer. */
  steps: FlowStep[];
  /** Oppsett i Genki: hva tjenesteeier gjør for å lage og publisere tjenesten. */
  setup: FlowStep[];
};

const kunnskapsassistentSteps: FlowStep[] = [
  {
    id: 'sporsmal',
    title: 'En ansatt stiller et spørsmål',
    text: 'I arbeidsflaten, i et eget chatverktøy eller fra en agent over MCP eller A2A. Alle kanaler ender i samme forespørsel.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
  {
    id: 'palogging',
    title: 'Identitet og rettigheter sjekkes',
    text: 'Ansattporten sier hvem personen er. Altinn sier hvilke tjenester personen har rett til i denne organisasjonen.',
    block: 'autentisering',
    node: 'identitet',
  },
  {
    id: 'tjeneste',
    title: 'Den publiserte versjonen hentes',
    text: 'Kjernen slår opp tjenesten, varianten og arbeidsmåten i den publiserte definisjonen. Utkast påvirker aldri brukerne.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'oppgave',
    title: 'Kallet blir en oppgave',
    text: 'Kjernen oppretter en oppgave med append-only logg og sjekker kvote og budsjett før noe kjører.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'sok',
    title: 'Agenten planlegger og søker',
    text: 'Agentløkken søker i datasettene, leser de beste treffene og lar rerankeren velge kildene. Hooks kan gripe inn før og etter søk.',
    block: 'rag',
    node: 'data',
  },
  {
    id: 'modell',
    title: 'Modellen svarer gjennom gatewayen',
    text: 'Gatewayen ruter til modellen tjenesten har valgt, innenfor dataresidens, og teller tokens og kostnad.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'guardrails',
    title: 'Guardrails og kilder',
    text: 'Svaret sjekkes, merkes som laget med KI og får nummererte kilder. Alt logges på oppgaven.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'tilbakemelding',
    title: 'Tilbakemelding blir til neste versjon',
    text: 'Ja og nei fra brukerne blir hendelser på oppgaven. Tjenesteeier bruker dem i testsett, og en ny versjon må gjennom publiseringsportene.',
    block: 'evals',
    node: 'kvalitet',
  },
];

const kiNorgeChatbotSteps: FlowStep[] = [
  {
    id: 'sporsmal',
    title: 'En innbygger spør på ki.norge.no',
    text: 'Chatboten ligger i nettsidens egen frontend og snakker med Genki over det OpenAI-kompatible API-et. Ingen innlogging for personen.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
  {
    id: 'system',
    title: 'Nettstedet autentiseres som system',
    text: 'Frontenden har en nøkkel utstedt av gatewayen og er registrert som en virksomhetskanal. Brukeren er anonym, men kanalen er kjent.',
    block: 'autentisering',
    node: 'identitet',
  },
  {
    id: 'tjeneste',
    title: 'Tjenestedefinisjonen for ki.norge.no hentes',
    text: 'Definisjonen sier at svar skal holde seg til innholdet på ki.norge.no, alltid vise kilder, og henvise videre når spørsmålet går utenfor.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'oppgave',
    title: 'Oppgave med ratebegrensning og budsjett',
    text: 'Fordi kanalen er åpen for alle, sjekker kjernen rate per kanal og dagsbudsjett før noe kjører. Alt logges uten persondata.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'sok',
    title: 'Søk i datasettet fra ki.norge.no',
    text: 'Et datasett som høstes fra nettstedet ved hver publisering. Hybridsøk og reranking finner avsnittene som faktisk svarer.',
    block: 'rag',
    node: 'data',
  },
  {
    id: 'modell',
    title: 'En norsk-hostet modell svarer',
    text: 'Tjenesten krever dataresidens i Norge, så gatewayen ruter til en modell som oppfyller det, og teller tokens på kanalen.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'guardrails',
    title: 'Kilder, KI-merking og trygg avvisning',
    text: 'Svaret får lenker til sidene det bygger på. Spørsmål utenfor innholdet får et høflig «dette kan jeg ikke svare på» i stedet for gjetning.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'evals',
    title: 'Ekte spørsmål blir testsett',
    text: 'Anonymiserte spørsmål og tommel opp eller ned går inn i testsettet. Ny versjon av innhold eller instruks må bestå det før publisering.',
    block: 'evals',
    node: 'kvalitet',
  },
];

const klarsprakSteps: FlowStep[] = [
  {
    id: 'marker',
    title: 'Saksbehandleren markerer et avsnitt',
    text: 'I fagsystemet ligger en knapp «Skriv klarere». Fagsystemet kaller Genki med teksten og hvem som ber om det.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
  {
    id: 'palogging',
    title: 'Ansattporten og rettigheter',
    text: 'Saksbehandleren er allerede logget inn med Ansattporten. Altinn bekrefter at organisasjonen har tilgang til klarspråktjenesten.',
    block: 'autentisering',
    node: 'identitet',
  },
  {
    id: 'tjeneste',
    title: 'Klarspråk-definisjonen hentes',
    text: 'Definisjonen har språkinstruksjoner, målgruppe og regler som «ikke legg til fakta». Varianter finnes for bokmål og nynorsk.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'oppgave',
    title: 'Oppgave uten søk, men med logg',
    text: 'Dette er en enkel arbeidsmåte uten agentløkke. Kjernen logger likevel hva som gikk inn og ut, for sporbarhet i saken.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'verktoy',
    title: 'Termliste og skriveregler som verktøy',
    text: 'Et verktøy slår opp virksomhetens termliste og Språkrådets regler, så modellen bruker de riktige ordene.',
    block: 'verktoy',
    node: 'verktoy',
  },
  {
    id: 'modell',
    title: 'Modellen skriver om',
    text: 'Gatewayen velger modellen varianten peker på. Tekst i saker krever residens i Norge eller EU, og gatewayen håndhever det.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'kontroll',
    title: 'Sjekk at ingenting er lagt til',
    text: 'En guardrail sammenligner fakta i originalen og omskrivingen. Saksbehandleren ser forslaget side om side og velger selv.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'evals',
    title: 'Lesbarhet måles på testsett',
    text: 'Et testsett med ekte avsnitt og dommere for lesbarhet og faktatroskap. Ny modell eller instruks må gjøre det like bra før den slippes.',
    block: 'evals',
    node: 'kvalitet',
  },
];

const postmottakSteps: FlowStep[] = [
  {
    id: 'henvendelse',
    title: 'En henvendelse kommer inn i postmottaket',
    text: 'Sak- og arkivsystemet kaller agenten maskinelt over A2A for hvert nytt dokument. Ingen person er involvert ennå.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
  {
    id: 'maskinporten',
    title: 'Systemet autentiseres med Maskinporten',
    text: 'Arkivsystemet har et Maskinporten-token med rett scope. Agenten kjører med rettighetene til organisasjonen, ikke til en ansatt.',
    block: 'autentisering',
    node: 'identitet',
  },
  {
    id: 'tjeneste',
    title: 'Agentdefinisjonen hentes',
    text: 'Definisjonen beskriver en stegflyt: klassifiser, foreslå saksbehandler, lag sammendrag, og stopp for menneskelig godkjenning.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'oppgave',
    title: 'En oppgave med flere steg',
    text: 'Kjernen kjører stegflyten og logger hvert steg på oppgaven. Hvis ett steg feiler, stopper flyten der og kan tas opp igjen.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'verktoy',
    title: 'Verktøy mot arkiv og saksbehandlerliste',
    text: 'Agenten slår opp lignende saker og hvem som har ledig kapasitet gjennom verktøy beskrevet med OpenAPI. Den endrer ingenting selv.',
    block: 'verktoy',
    node: 'verktoy',
  },
  {
    id: 'modell',
    title: 'Klassifisering og sammendrag',
    text: 'Gatewayen ruter til en rimelig modell for klassifisering og en sterkere for sammendrag. Begge innenfor budsjettet til tjenesten.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'godkjenning',
    title: 'Mennesket godkjenner',
    text: 'Forslaget legges i arkivsystemet som utkast, merket som laget med KI. En ansatt godkjenner eller endrer før saken fordeles.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'evals',
    title: 'Treffsikkerhet følges over tid',
    text: 'Hvor ofte mennesket endrer forslaget blir en måleserie. Faller treffsikkerheten, stopper publiseringsporten neste versjon.',
    block: 'evals',
    node: 'kvalitet',
  },
];

const altinnSkjemaSteps: FlowStep[] = [
  {
    id: 'skjema',
    title: 'En virksomhet fyller ut et skjema i en Altinn-app',
    text: 'Appen er bygd i Altinn Studio. Ved et fritekstfelt ligger knappen «Få hjelp til å fylle ut». Brukeren er allerede logget inn i Altinn med ID-porten.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
  {
    id: 'backend',
    title: 'Appens backend kaller Genki',
    text: 'App-backenden har et Maskinporten-token og sender med hvem det handles på vegne av: personen og organisasjonen fra Altinn. Ingen ny pålogging.',
    block: 'autentisering',
    node: 'identitet',
  },
  {
    id: 'tjeneste',
    title: 'Tjenesten «skjemahjelp» hentes',
    text: 'Definisjonen har et input-skjema med feltets navn, veiledningstekst og det brukeren har skrevet så langt, og et output-skjema for forslaget.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'veiledning',
    title: 'Veiledningen til skjemaet slås opp',
    text: 'Et datasett med veiledningstekst og regelverk for akkurat dette skjemaet. Søket finner det som gjelder feltet, så forslaget bygger på riktig grunnlag.',
    block: 'rag',
    node: 'data',
  },
  {
    id: 'modell',
    title: 'Modellen lager et forslag',
    text: 'Gatewayen ruter til en modell med residens i EU, som definisjonen krever for opplysninger i søknader. Forslaget er kort og i klarspråk.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'validering',
    title: 'Forslaget valideres og merkes',
    text: 'Kjernen sjekker svaret mot output-skjemaet og at ingen nye faktaopplysninger er lagt til. Forslaget merkes som laget med KI.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'bruker',
    title: 'Brukeren godkjenner eller endrer',
    text: 'Appen viser forslaget ved siden av feltet. Brukeren velger selv om det skal brukes. Ingenting sendes inn uten at brukeren har sett det.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
  {
    id: 'evals',
    title: 'Treff og avvik måles',
    text: 'Hvor ofte forslaget brukes uendret blir en måleserie. Et testsett med ekte felt og forventede forslag må bestås før en ny versjon slippes.',
    block: 'evals',
    node: 'kvalitet',
  },
];

const altinnSkjemaSetup: FlowStep[] = [
  {
    id: 'mal',
    title: 'Velg malen «Skjemahjelp» i portalen',
    text: 'Tjenesteeier i kommunen eller etaten starter fra en mal for strukturert hjelp i skjema: enkeltkall, input- og output-skjema, klarspråkinstruks.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'data',
    title: 'Legg til veiledningen som datasett',
    text: 'Veiledningsteksten og regelverket for skjemaet hentes inn fra nettsiden eller et dokument. Innhentingen kjøres på nytt når veiledningen endres.',
    block: 'rag',
    node: 'data',
  },
  {
    id: 'modell',
    title: 'Velg modell og residens',
    text: 'Fra katalogen velges en rask modell med EU-residens. Kostnad per kall vises med en gang, og et budsjett settes for tjenesten.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'test',
    title: 'Test i playground og lag testsett',
    text: 'Tjenesteeier prøver ekte felt og tekster i playground, og lagrer de beste som testcases med forventet forslag.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'tilgang',
    title: 'Gi Altinn-appen tilgang',
    text: 'Appens Maskinporten-klient registreres som systembruker med rett til å bruke tjenesten på vegne av organisasjonen.',
    block: 'tilgangsstyring',
    node: 'tilgang',
  },
  {
    id: 'publiser',
    title: 'Publiser og koble til appen',
    text: 'Publiseringsportene kjøres. Deretter kaller Altinn-appen tjenesten fra sin backend, med input-skjemaet fra definisjonen.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
];

const kommunalSoknadSteps: FlowStep[] = [
  {
    id: 'soknad',
    title: 'En søknad kommer inn til kommunen',
    text: 'En innbygger søker om parkeringstillatelse for forflytningshemmede i et digitalt skjema. Søknaden lander i sak- og arkivsystemet.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
  {
    id: 'system',
    title: 'Arkivsystemet starter agenten',
    text: 'For hver ny søknad kaller arkivsystemet agenten over A2A med Maskinporten-token. Agenten kjører som systembruker for kommunen.',
    block: 'tilgangsstyring',
    node: 'tilgang',
  },
  {
    id: 'tjeneste',
    title: 'Agentdefinisjonen hentes',
    text: 'En stegflyt: hent opplysninger, sjekk vilkår mot regelverk, lag vedtaksutkast, og stopp for godkjenning. Risikoklassen er høy, så alle steg logges.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'verktoy',
    title: 'Opplysninger hentes med verktøy',
    text: 'Agenten slår opp bostedsadresse i Folkeregisteret, legeerklæringen i vedlegget, og tidligere vedtak i arkivet, alle via OpenAPI-verktøy med avgrenset tilgang.',
    block: 'verktoy',
    node: 'verktoy',
  },
  {
    id: 'regelverk',
    title: 'Vilkårene slås opp i regelverket',
    text: 'Forskriften og kommunens retningslinjer ligger som datasett. Agenten finner vilkårene som gjelder, med kilde til hvert av dem.',
    block: 'rag',
    node: 'data',
  },
  {
    id: 'modell',
    title: 'Modellen vurderer og skriver utkast',
    text: 'Gatewayen ruter til en modell med norsk residens. Utkastet begrunner hvert vilkår med opplysning og kilde, i klarspråk.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'godkjenning',
    title: 'Saksbehandler godkjenner',
    text: 'Agenten legger vedtaksutkastet i saken, merket som laget med KI. Klare innvilgelser kan godkjennes med ett klikk; avslag og tvil krever full gjennomgang.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'evals',
    title: 'Vedtakene følges opp',
    text: 'Hvor ofte saksbehandler endrer utkastet, og klager på vedtak, blir måleserier. Ny versjon av agenten må bestå et testsett med anonymiserte saker.',
    block: 'evals',
    node: 'kvalitet',
  },
];

const kommunalSoknadSetup: FlowStep[] = [
  {
    id: 'definisjon',
    title: 'Beskriv stegflyten i portalen',
    text: 'Kommunen definerer agenten med stegene hent, vurder, skriv, godkjenn. Byggeassistenten foreslår, en fagperson godkjenner. Risikoklasse settes til høy.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'verktoy',
    title: 'Koble på verktøy',
    text: 'Folkeregisteret, arkivet og vedleggslesing registreres som OpenAPI-verktøy med manifest som avgrenser hva agenten får slå opp.',
    block: 'verktoy',
    node: 'verktoy',
  },
  {
    id: 'data',
    title: 'Legg inn regelverk og retningslinjer',
    text: 'Forskriften og kommunens egne retningslinjer hentes inn som datasett, så vilkårene alltid siteres fra gjeldende tekst.',
    block: 'rag',
    node: 'data',
  },
  {
    id: 'modell',
    title: 'Velg modell med norsk residens',
    text: 'Sakene inneholder helseopplysninger. Katalogen filtreres på residens i Norge, og en modell med gode verktøykall velges.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'testsett',
    title: 'Bygg testsett av anonymiserte saker',
    text: 'Saksbehandlere merker 50 tidligere saker med riktig utfall. Dommere sjekker at utkastet treffer utfallet og begrunner med riktige vilkår.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'tilgang',
    title: 'Gi arkivsystemet rett til å starte agenten',
    text: 'Arkivsystemets Maskinporten-klient registreres som systembruker. Saksbehandlerne får rett til å godkjenne gjennom Altinn.',
    block: 'tilgangsstyring',
    node: 'tilgang',
  },
  {
    id: 'publiser',
    title: 'Publiser med porter og overvåk',
    text: 'Publiseringsportene krever at testsettet bestås. Etter publisering følges treffsikkerhet og klager i dashboardet, og agenten kan trekkes tilbake på minutter.',
    block: 'evals',
    node: 'kvalitet',
  },
];

const kunnskapsassistentSetup: FlowStep[] = [
  {
    id: 'definisjon',
    title: 'Opprett tjenesten i portalen',
    text: 'Digdir beskriver Kunnskapsassistenten: formål, målgruppe ansatte, arbeidsmåte søk og svar, og instruks om alltid å vise kilder.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'data',
    title: 'Hent inn rapportene fra Kudos',
    text: 'Et datasett kobles til Kudos. Innhentingen gjør PDF til Markdown, deler i biter og indekserer. Nye rapporter kommer med automatisk.',
    block: 'rag',
    node: 'data',
  },
  {
    id: 'modell',
    title: 'Velg modell og reranker',
    text: 'En sterk modell for svar og en reranker for kildene velges fra katalogen, begge innenfor residenskravet EU.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'testsett',
    title: 'Lag testsett og dommere',
    text: 'Ekte spørsmål med forventede kilder blir testsett. En dommer måler faktatroskap mot kildene, en annen at svaret har kilder.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'tilgang',
    title: 'Bestem hvem som får bruke den',
    text: 'Tjenesten registreres i Ressursregisteret. Virksomheter gir sine ansatte tilgang gjennom Altinn.',
    block: 'tilgangsstyring',
    node: 'tilgang',
  },
  {
    id: 'publiser',
    title: 'Publiser til arbeidsflaten og API-et',
    text: 'Portene kjøres og versjonen publiseres. Tjenesten dukker opp i arbeidsflaten, som modell i det OpenAI-kompatible API-et og som MCP-verktøy.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
];

const kiNorgeChatbotSetup: FlowStep[] = [
  {
    id: 'definisjon',
    title: 'Tjenesteutvikleren starter fra malen «Chatbot for nettsted»',
    text: 'I Genki-portalen velges malen. Byggeassistenten spør om nettsted, målgruppe og tone, og fyller ut definisjonen i samtale. Utvikleren justerer i enkel visning eller YAML.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'data',
    title: 'Koble til nettstedet som datasett',
    text: 'ki.norge.no legges til som kilde med høsting ved publisering. Første innhenting viser antall sider, biter og eventuelle feil.',
    block: 'rag',
    node: 'data',
  },
  {
    id: 'modell',
    title: 'Velg modell med norsk residens',
    text: 'Katalogen filtreres på residens i Norge. Utvikleren velger en modell, ser pris per tusen samtaler, og setter dagsbudsjett for kanalen.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'guardrails',
    title: 'Sett guardrails og avvisning',
    text: 'Definisjonen får regler om å holde seg til nettstedet, avvise høflig utenfor, aldri be om persondata, og alltid vise kilder. Alt er konfigurasjon.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'test',
    title: 'Test i playground og bygg testsett',
    text: 'Utvikleren stiller vanlige og vanskelige spørsmål side om side med to modeller, og lagrer de beste som testcases med forventet kilde.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'nokkel',
    title: 'Lag nøkkel til nettstedet',
    text: 'En virtuell nøkkel for kanalen ki.norge.no utstedes med ratebegrensning og budsjett. Nøkkelen legges i nettstedets frontend-konfigurasjon.',
    block: 'autentisering',
    node: 'identitet',
  },
  {
    id: 'publiser',
    title: 'Publiser og sett inn KI-komponenten',
    text: 'Portene kjøres og versjonen publiseres. Chat-komponenten fra Designsystemet settes inn på nettstedet og peker på tjenesten. Tilbakemeldinger går rett til testsettet.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
];

const klarsprakSetup: FlowStep[] = [
  {
    id: 'definisjon',
    title: 'Kopier malen «Klarspråk»',
    text: 'Tjenesteeier kopierer Klarspråk-tjenesten og tilpasser instruksen til virksomhetens målgruppe. Varianter for bokmål og nynorsk følger med.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'verktoy',
    title: 'Legg inn termlisten som verktøy',
    text: 'Virksomhetens termliste registreres som et lite verktøy, så modellen slår opp riktige ord i stedet for å gjette.',
    block: 'verktoy',
    node: 'verktoy',
  },
  {
    id: 'modell',
    title: 'Velg modell',
    text: 'En rask modell med residens i Norge eller EU, siden tekstene kommer fra saker. Kostnaden per avsnitt vises.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'testsett',
    title: 'Testsett for lesbarhet og faktatroskap',
    text: 'Ekte avsnitt med godkjente omskrivinger blir testsett. Dommere måler lesbarhet og at ingen fakta er lagt til eller fjernet.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'tilgang',
    title: 'Gi fagsystemet tilgang',
    text: 'Fagsystemets Maskinporten-klient får rett til tjenesten, og saksbehandlerne får tilgang gjennom Altinn.',
    block: 'tilgangsstyring',
    node: 'tilgang',
  },
  {
    id: 'publiser',
    title: 'Publiser og koble til knappen i fagsystemet',
    text: 'Etter portene kaller fagsystemet tjenesten fra sin backend med teksten og hvem som ber om det. Forslaget vises side om side med originalen.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
];

const postmottakSetup: FlowStep[] = [
  {
    id: 'definisjon',
    title: 'Beskriv stegflyten',
    text: 'Agenten defineres med stegene klassifiser, foreslå saksbehandler, lag sammendrag, og stopp for godkjenning. Hvert steg har egen instruks.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'verktoy',
    title: 'Koble på arkiv og saksbehandlerliste',
    text: 'Arkivsystemets API og listen over saksbehandlere registreres som OpenAPI-verktøy. Manifestet gir bare lesetilgang.',
    block: 'verktoy',
    node: 'verktoy',
  },
  {
    id: 'modell',
    title: 'Velg to modeller',
    text: 'En rimelig modell for klassifisering og en sterkere for sammendrag velges i katalogen, med budsjett per dag.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'testsett',
    title: 'Testsett fra tidligere henvendelser',
    text: 'Et år med henvendelser og hvordan de faktisk ble fordelt blir testsett. Treffsikkerhet på kategori og saksbehandler måles.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'tilgang',
    title: 'Registrer arkivsystemet som systembruker',
    text: 'Arkivsystemet får rett til å starte agenten med Maskinporten, og de ansatte som skal godkjenne får rett gjennom Altinn.',
    block: 'tilgangsstyring',
    node: 'tilgang',
  },
  {
    id: 'publiser',
    title: 'Publiser som A2A-agent',
    text: 'Etter portene eksponeres agenten med agentkort. Arkivsystemet kaller den for hvert nytt dokument, og treffsikkerheten følges i dashboardet.',
    block: 'evals',
    node: 'kvalitet',
  },
];

const agentiskUtviklingSteps: FlowStep[] = [
  {
    id: 'utvikler',
    title: 'En utvikler jobber med en kodeagent',
    text: 'I en etat sitter en utvikler med en kodeagent i editoren eller terminalen. Agenten snakker det OpenAI-kompatible API-et, så den peker på Genki-gatewayen i stedet for en utenlandsk leverandør.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
  {
    id: 'nokkel',
    title: 'Virksomhetens nøkkel identifiserer kallet',
    text: 'Kodeagenten bruker en nøkkel gatewayen har utstedt til etaten, knyttet til utvikleren som principal. Hvert kall vet hvem og hvilken virksomhet det handler på vegne av.',
    block: 'autentisering',
    node: 'identitet',
  },
  {
    id: 'ruting',
    title: 'Gatewayen ruter til «kode-norge»',
    text: 'Agenten ber om det virtuelle modellnavnet kode-norge. Gatewayen sjekker budsjett for teamet, residenskravet Norge, og ruter til en åpen modell. Faller én instans ut, tar neste over.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'infra',
    title: 'Modellen kjører på felles infrastruktur i Norge',
    text: 'En åpen vektmodell for kode kjører på GPU-kapasitet DFØ har anskaffet felles på vegne av offentlig sektor, i et datasenter på norsk jord. Kildekoden forlater aldri landet.',
    block: 'ki-infrastruktur',
    node: 'infra',
  },
  {
    id: 'verktoy',
    title: 'Agenten leser, endrer og tester',
    text: 'Kodeagenten bruker verktøy mot repoet, kjører tester og slår opp i oppgaver og dokumentasjon via MCP. Verktøyene mot interne systemer går gjennom MCP-gatewayen med etatens policy.',
    block: 'verktoy',
    node: 'verktoy',
  },
  {
    id: 'guardrails',
    title: 'Hemmeligheter og persondata stoppes',
    text: 'Guardrails maskerer nøkler, passord og persondata før de når modellen. Sporingen logger metrikker og tokens, ikke kodeinnhold.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'review',
    title: 'Utvikleren vurderer endringen',
    text: 'Agenten leverer en pull request, merket som laget med KI. Utvikleren leser, justerer og godkjenner. Ingenting slås sammen uten et menneske.',
    block: 'agent-runtime',
    node: 'kjerne',
  },
  {
    id: 'maling',
    title: 'Bruk og nytte måles',
    text: 'Tokens, kostnad og latens per team går til dashboardet. Andel forslag som tas i bruk og tid til ferdig oppgave måles, og brukes når modellen skal byttes.',
    block: 'evals',
    node: 'kvalitet',
  },
];

const agentiskUtviklingSetup: FlowStep[] = [
  {
    id: 'anskaffelse',
    title: 'DFØ anskaffer felles regnekraft på norsk jord',
    text: 'DFØ bruker statens samlede innkjøpsmakt gjennom Markedsplassen for skytjenester og anskaffer GPU-kapasitet og KI-modeller på vegne av hele offentlig sektor, med oppdaterte krav til sikkerhet og personvern. Alle virksomheter kan avrope på avtalen. Én anskaffelse i stedet for hundre.',
    block: 'ki-infrastruktur',
    node: 'infra',
  },
  {
    id: 'modell',
    title: 'Drift en åpen kodemodell',
    text: 'En åpen vektmodell med god kodeforståelse velges og driftes med en inferensserver som eksponerer et OpenAI-kompatibelt API. Vekter og lisens dokumenteres.',
    block: 'sprakmodeller',
    node: 'inferens',
  },
  {
    id: 'katalog',
    title: 'Registrer modellen i gatewayen',
    text: 'Modellen legges i katalogen som det virtuelle navnet kode-norge, med residens Norge, pris per token og en reserveinstans for failover.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'nokler',
    title: 'Utsted nøkler til virksomhetene',
    text: 'Hver etat får nøkler med budsjett per team og utløpsdato. Leverandørlegitimasjon finnes bare i gatewayen. Forbruk attribueres til etaten.',
    block: 'autentisering',
    node: 'identitet',
  },
  {
    id: 'verktoy',
    title: 'Sett opp MCP-gateway og verktøypolicy',
    text: 'Godkjente MCP-servere for oppgaver, dokumentasjon og kodelager samles i én katalog, filtrert per etat. Hemmeligheter til verktøyene holdes i gatewayen.',
    block: 'verktoy',
    node: 'verktoy',
  },
  {
    id: 'evals',
    title: 'Mål modellen på offentlig sektors kode',
    text: 'Et testsett med oppgaver fra åpne repoer i forvaltningen, med tester som fasit. Kjøres på hver ny modellkandidat før den slippes som kode-norge.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'oppskrift',
    title: 'Publiser oppskriften',
    text: 'En kort veiledning for å peke vanlige kodeagenter på gatewayen: URL, modellnavn og nøkkel. Etatene er i gang på en formiddag, og kan bytte modell uten å endre noe.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
];

const norskeModellerSteps: FlowStep[] = [
  {
    id: 'tjenester',
    title: 'Mange tjenester bruker samme norske modell',
    text: 'Kunnskapsassistenter, klarspråk og chatboter i ulike virksomheter har valgt Borealis eller en annen norsk modell som svarmodell eller variant. Hver tjeneste har sitt eget testsett.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'eksperiment',
    title: 'Hver tjeneste kjører eksperimenter uansett',
    text: 'For å få publisere må tjenesten bestå portene: testsettet kjøres mot modellen, dommerne skårer faktatroskap, relevans og språk. Det samme gjøres når en ny modell vurderes. Ingen ekstra jobb for å bidra.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'porten',
    title: 'KI-porten vet hvilken modell som svarte',
    text: 'Hvert kall i et eksperiment går gjennom KI-porten, som logger modell og versjon. Dermed kan resultater for Borealis 12B skilles fra 27B og fra andre modeller på samme testsett.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'aggregat',
    title: 'Resultatene samles per modell på tvers av tjenester',
    text: 'Plattformen summerer eksperimentene per modell, oppgavetype og språkform: skårer, ikke spørsmål eller svar. Det er det samme tallgrunnlaget virksomhetene selv bruker for å velge modell, bare sett fra modellens side.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'innsyn',
    title: 'Nasjonalbiblioteket ser det samlede bildet',
    text: 'Aggregatet er tilgjengelig for Nasjonalbibliotekets KI-lab som et dashboard og et API: hvor modellen treffer, hvor den bommer, på hvilke oppgavetyper og språkformer, i reelle KI-tjenester på tvers av offentlig sektor.',
    block: 'kanaler',
    node: 'grensesnitt',
  },
  {
    id: 'modell',
    title: 'Modellen forbedres',
    text: 'Nasjonalbiblioteket ser at nynorsk og juridisk språk skårer lavere enn bokmål og hverdagsspråk, og bruker det i neste treningsrunde på Olivia.',
    block: 'sprakmodeller',
    node: 'inferens',
  },
  {
    id: 'katalog',
    title: 'Ny versjon inn i katalogen',
    text: 'Den nye modellversjonen legges i KI-portens katalog ved siden av den gamle, tilgjengelig for kanarilansering under samme virtuelle navn.',
    block: 'ki-gateway',
    node: 'modeller',
  },
  {
    id: 'reeval',
    title: 'Eksperimentene kjøres på nytt',
    text: 'Hver tjeneste kjører testsettet sitt mot den nye versjonen før den tar den i bruk, slik portene krever. Skårene går inn i samme aggregat, og forbedringen kan dokumenteres for hele forvaltningen.',
    block: 'evals',
    node: 'kvalitet',
  },
];

const norskeModellerSetup: FlowStep[] = [
  {
    id: 'testsett',
    title: 'Merk testsettene med oppgavetype og språkform',
    text: 'Testcases får merker som «oppsummering, nynorsk» eller «spørsmål og svar, juridisk». Det er nyttig for tjenesten selv, og gjør at resultater kan sammenlignes på tvers.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'porter',
    title: 'La portene kjøre eksperimentet mot norske modeller',
    text: 'Publiseringsportene i definisjonen krever at testsettet er kjørt mot modellen tjenesten bruker. Vurderer tjenesten en norsk modell som alternativ, kjøres samme eksperiment mot den.',
    block: 'definisjoner',
    node: 'tjenester',
  },
  {
    id: 'aggregat',
    title: 'Aggregert visning per modell i dashboardet',
    text: 'Dashboardet i kvalitetslaget får en visning per modell på tvers av tjenester og virksomheter: skårer per dommer, oppgavetype og språkform. Bare tall, aldri innhold.',
    block: 'evals',
    node: 'kvalitet',
  },
  {
    id: 'tilgang',
    title: 'Gi Nasjonalbiblioteket innsyn i aggregatet',
    text: 'Nasjonalbibliotekets KI-lab får tilgang til visningen og et API for de norske modellene, autentisert med Maskinporten. Aggregerte skårer er ikke sensitive, så det trengs ingen egen avtale om data.',
    block: 'tilgangsstyring',
    node: 'tilgang',
  },
  {
    id: 'begge-veier',
    title: 'Vis innsikten til virksomhetene også',
    text: 'Samme visning hjelper virksomhetene å velge: hvordan gjør Borealis det på min oppgavetype hos andre? Modellvalget bygger på mer enn eget testsett, og forbedringen kommer alle til gode.',
    block: 'evals',
    node: 'kvalitet',
  },
];

export const cases: Case[] = [
  {
    id: 'kunnskapsassistenten',
    name: 'Kunnskapsassistenten',
    intro:
      'Hva skjer når en ansatt spør Kunnskapsassistenten? Åtte steg gjennom byggeklossene, fra spørsmål til svar med kilder. Spill av, eller klikk deg gjennom stegene selv.',
    steps: kunnskapsassistentSteps,
    setup: kunnskapsassistentSetup,
  },
  {
    id: 'ki-norge-chatbot',
    name: 'RAG-chatbot for et åpent nettsted',
    intro:
      'En tenkt chatbot som svarer innbyggere og virksomheter om innholdet på ki.norge.no. Åpen for alle, uten innlogging, med kilder i hvert svar og en norsk-hostet modell.',
    steps: kiNorgeChatbotSteps,
    setup: kiNorgeChatbotSetup,
  },
  {
    id: 'klarsprak-i-saksbehandling',
    name: 'Omskriving med kontroll',
    intro:
      'En tenkt tjeneste der saksbehandleren får et avsnitt skrevet klarere rett i fagsystemet. Enkel arbeidsmåte uten søk, men med termliste, faktakontroll og måling av lesbarhet.',
    steps: klarsprakSteps,
    setup: klarsprakSetup,
  },
  {
    id: 'postmottak-agent',
    name: 'Maskinell flyt med menneske i løkken',
    intro:
      'En tenkt agent som klassifiserer innkommende henvendelser, foreslår saksbehandler og lager sammendrag. Kalles maskinelt fra arkivsystemet, og et menneske godkjenner før noe skjer.',
    steps: postmottakSteps,
    setup: postmottakSetup,
  },
  {
    id: 'altinn-skjemahjelp',
    name: 'Hjelp til skjemautfylling',
    intro:
      'En tenkt Altinn-app bygd i Altinn Studio, der brukeren får hjelp til å fylle ut et fritekstfelt. KI-en er én funksjon i skjemaet, kalles fra appens backend, og brukeren godkjenner alltid forslaget selv.',
    steps: altinnSkjemaSteps,
    setup: altinnSkjemaSetup,
  },
  {
    id: 'kommunal-soknad',
    name: 'Agent som forbereder vedtak',
    intro:
      'En tenkt agent som behandler søknader om parkeringstillatelse for forflytningshemmede: henter opplysninger, sjekker vilkår mot regelverket og skriver vedtaksutkast. Saksbehandler godkjenner, og bare klare tilfeller går raskt.',
    steps: kommunalSoknadSteps,
    setup: kommunalSoknadSetup,
  },
  {
    id: 'agentisk-utvikling',
    name: 'Kodeagenter på åpen modell og felles infrastruktur i Norge',
    intro:
      'En tenkt flyt der utviklere i forvaltningen bruker kodeagenter gjennom KI-porten, mot en åpen modell som kjører på regnekraft DFØ har anskaffet felles på vegne av offentlig sektor, på norsk jord. Kildekoden forlater aldri landet, og hver etat betaler for sitt forbruk.',
    steps: agentiskUtviklingSteps,
    setup: agentiskUtviklingSetup,
  },
  {
    id: 'forbedring-norske-modeller',
    name: 'Forbedring av norske modeller',
    intro:
      'En tenkt flyt der modellforbedring blir en naturlig konsekvens av kvalitetsarbeidet hver tjeneste uansett må gjøre. Testsett og eksperimenter mot Borealis og andre norske modeller summeres per modell på tvers av tjenester, og Nasjonalbiblioteket ser hvordan modellen presterer i reelle KI-tjenester på tvers av offentlig sektor.',
    steps: norskeModellerSteps,
    setup: norskeModellerSetup,
  },
];

export const caseById = (id: string) => cases.find((c) => c.id === id);

export const links = {
  repo: 'https://github.com/digdir/genki',
  adr: 'https://github.com/digdir/genki/tree/main/docs/adr',
  api: 'https://github.com/digdir/genki/blob/main/docs/api/README.md',
  frontend: 'https://github.com/digdir/genki/blob/main/docs/build-a-frontend.md',
  byol: 'https://github.com/digdir/genki/blob/main/docs/bring-your-own-logic.md',
  headlessRag: 'https://github.com/digdir/digdir-headless-rag',
  designsystemet: 'https://www.designsystemet.no',
};
