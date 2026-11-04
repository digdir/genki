/**
 * Typene KI-tjenester en virksomhet kan bygge på Genki. Vist øverst i hero-figuren,
 * hver med egen side. Legg til flere her.
 */
export type ServiceType = {
  id: string;
  name: string;
  nameEn: string;
  tagline: string;
  intro: string;
  description: string[];
  /** Når typen passer, og når den ikke gjør det. */
  fits: string[];
  avoid: string[];
  /** Hvordan den bygges på Genki: arbeidsmåte, kanaler, byggeklosser. */
  build: { label: string; text: string; block?: string }[];
  examples: string[];
  /** Flyter (cases) som viser typen i praksis. */
  cases: string[];
};

export const serviceTypes: ServiceType[] = [
  {
    id: 'assistenter',
    name: 'Assistenter',
    nameEn: 'Assistants',
    tagline: 'Hjelper en ansatt med en oppgave, med virksomhetens egne kilder',
    intro:
      'En assistent er en KI-tjeneste for ansatte: den svarer på spørsmål, finner fram i dokumenter, skriver utkast og forklarer, alltid med kilder. Den brukes i arbeidsflaten eller rett i fagsystemet, og den ansatte har siste ord.',
    description: [
      'Assistenter er den vanligste typen KI-tjeneste i forvaltningen. De bygger på virksomhetens egne data gjennom RAG, svarer med nummererte kilder og er tilgjengelige der den ansatte allerede jobber. Kunnskapsassistenten i Genki er et eksempel: den svarer på spørsmål om offentlige rapporter med kilder fra Kudos.',
      'Forskjellen fra en chatbot er hvem den er for og hva den har tilgang til. En assistent er for innloggede ansatte, kjenner identiteten deres gjennom Ansattporten, og kan derfor søke i interne dokumenter den ansatte har rett til å se.',
      'Forskjellen fra en agent er at assistenten svarer og foreslår, men ikke handler. Den skriver et utkast, men sender det ikke. Den finner saken, men fordeler den ikke.',
    ],
    fits: [
      'Ansatte trenger raske, dokumenterte svar fra store mengder tekst',
      'Svaret må kunne spores til en kilde',
      'Oppgaven er å finne, forklare, oppsummere eller skrive utkast',
      'Den ansatte skal vurdere og bestemme selv',
    ],
    avoid: [
      'Tjenesten skal handle i andre systemer uten at en person ser på det',
      'Brukerne er anonyme innbyggere (da er det en chatbot)',
      'Oppgaven er en fast prosess med mange steg (da er det en agent)',
    ],
    build: [
      {
        label: 'Arbeidsmåte',
        text: 'Søk og svar (rag-single-shot), eller agentløkke når spørsmålet krever flere søk',
        block: 'agent-runtime',
      },
      {
        label: 'Data',
        text: 'Ett eller flere datasett fra virksomhetens kilder, med tilgangsfilter på dokumentnivå',
        block: 'rag',
      },
      {
        label: 'Identitet',
        text: 'Ansattporten for pålogging, Altinn for hvem som får bruke tjenesten',
        block: 'autentisering',
      },
      {
        label: 'Kanal',
        text: 'Arbeidsflaten, KI-komponenter i fagsystemet, eller OpenAI-kompatibelt API fra eksisterende verktøy',
        block: 'kanaler',
      },
      {
        label: 'Modell',
        text: 'En sterk modell for kvalitet på svar, innenfor residenskravet til dataene',
        block: 'sprakmodeller',
      },
      {
        label: 'Kvalitet',
        text: 'Testsett fra ekte spørsmål, dommer for faktatroskap mot kildene, publiseringsport',
        block: 'evals',
      },
    ],
    examples: [
      'Kunnskapsassistenten: spørsmål om offentlige rapporter',
      'Regelverksassistent for saksbehandlere',
      'Assistent for interne rutiner og HR-spørsmål',
      'Skriveassistent med klarspråk og nynorsk',
    ],
    cases: ['kunnskapsassistenten', 'klarsprak-i-saksbehandling'],
  },
  {
    id: 'chatboter',
    name: 'Chatboter',
    nameEn: 'Chatbots',
    tagline: 'Svarer innbyggere og virksomheter på et nettsted, åpent for alle',
    intro:
      'En chatbot er en KI-tjeneste mot publikum: den svarer på spørsmål om innholdet på et nettsted eller om en tjeneste, uten innlogging, døgnet rundt. Den må være trygg, holde seg til det den vet, og si tydelig fra når den ikke kan svare.',
    description: [
      'Chatboter møter folk som ikke er logget inn og som ikke kjenner forvaltningen. De må svare presist på det de har grunnlag for, vise kilden, og henvise videre når spørsmålet går utenfor. Fordi kanalen er åpen, må plattformen begrense trafikk og kostnad per kanal, og logge uten persondata.',
      'Grunnlaget er typisk et datasett høstet fra nettstedet ved hver publisering, så chatboten alltid svarer i tråd med det som står der. Guardrails på inndata og utdata er strengere enn for en assistent, og svarene er alltid merket som laget med KI.',
      'En chatbot kan også gjøre mer enn å svare: med verktøy kan den slå opp status i en sak eller starte en henvendelse, men da må personen identifiseres med ID-porten først.',
    ],
    fits: [
      'Mange stiller de samme spørsmålene om et nettsted eller en tjeneste',
      'Innholdet er offentlig og godt strukturert',
      'Svarene kan avgrenses til et kjent grunnlag',
      'Det er viktig å avlaste telefon og e-post',
    ],
    avoid: [
      'Svarene krever innsikt i personens egen sak uten innlogging',
      'Innholdet endres raskere enn datasettet kan oppdateres',
      'Konsekvensen av et feil svar er stor og vanskelig å rette',
    ],
    build: [
      {
        label: 'Arbeidsmåte',
        text: 'Søk og svar med streng instruks om å holde seg til kildene og avvise det den ikke kan svare på',
        block: 'agent-runtime',
      },
      {
        label: 'Data',
        text: 'Datasett høstet fra nettstedet, oppdatert ved publisering',
        block: 'rag',
      },
      {
        label: 'Identitet',
        text: 'Nettstedet autentiseres som system med nøkkel fra KI-porten; personen er anonym, eller logger inn med ID-porten for egne saker',
        block: 'autentisering',
      },
      {
        label: 'Kanal',
        text: 'KI-komponenter på nettstedet, eller egen frontend mot det OpenAI-kompatible API-et',
        block: 'kanaler',
      },
      {
        label: 'KI-porten',
        text: 'Ratebegrensning og dagsbudsjett per kanal, modell med norsk residens',
        block: 'ki-gateway',
      },
      {
        label: 'Kvalitet',
        text: 'Anonymiserte spørsmål blir testsett, dommere for faktatroskap og trygg avvisning',
        block: 'evals',
      },
    ],
    examples: [
      'Chatbot på ki.norge.no om innholdet på nettstedet',
      'Veiledning om en offentlig tjeneste på etatens nettsider',
      'Spørsmål og svar for næringslivet om rapporteringsplikter',
    ],
    cases: ['ki-norge-chatbot'],
  },
  {
    id: 'apper',
    name: 'Apper',
    nameEn: 'Apps',
    tagline: 'Et fagsystem eller en nettside med KI innebygd i egne skjermbilder',
    intro:
      'En app bruker Genki som motor bak sitt eget brukergrensesnitt. KI-en vises ikke som en samtale, men som en funksjon i flyten: en knapp som skriver klarere, et felt som fylles ut automatisk, en kategori som foreslås, et sammendrag øverst i saken.',
    description: [
      'Mange av de mest nyttige KI-tjenestene er ikke chat. De er små, presise funksjoner inne i verktøyene folk allerede bruker: omskriving, klassifisering, uttrekk av felter fra et dokument, oppsummering, oversettelse. Genki leverer dem som tjenester med strukturert inn- og utdata, og appen bestemmer hvordan de vises.',
      'Fordi inn- og utdata er beskrevet med JSON Schema, kan appen validere svaret før det brukes, og tjenesten kan testes maskinelt. Tjenesten trenger ofte ingen samtalehistorikk og ingen søk, bare en god instruks og en passende modell.',
      'Apper kaller Genki fra sin egen backend med Maskinporten eller API-nøkkel, eller fra frontenden med KI-komponentene. Personen som bruker appen er kjent gjennom appens egen pålogging, og appen sender med hvem det handles på vegne av.',
    ],
    fits: [
      'KI-en skal være én funksjon i en større arbeidsflyt',
      'Inn- og utdata er strukturerte og kan valideres',
      'Virksomheten har allerede et fagsystem eller en nettside brukerne er i',
      'Oppgaven er omskriving, klassifisering, uttrekk eller oppsummering',
    ],
    avoid: [
      'Brukeren trenger å utforske og stille oppfølgingsspørsmål (da er det en assistent)',
      'Appen ikke kan vise hvor et forslag kommer fra når det trengs',
    ],
    build: [
      {
        label: 'Arbeidsmåte',
        text: 'Enkeltkall (single-call) med strukturert utdata, eller søk og svar når funksjonen trenger kilder',
        block: 'agent-runtime',
      },
      {
        label: 'Definisjon',
        text: 'Instruks med variabler, input-skjema og output som JSON Schema, varianter per språk',
        block: 'definisjoner',
      },
      {
        label: 'Identitet',
        text: 'Maskinporten eller API-nøkkel fra appens backend, med principal for hvem det handles på vegne av',
        block: 'autentisering',
      },
      {
        label: 'Kanal',
        text: 'OpenAI-kompatibelt API eller REST fra backend, KI-komponenter i frontend',
        block: 'kanaler',
      },
      {
        label: 'Modell',
        text: 'Ofte en liten og rask modell; en større bare der kvaliteten krever det',
        block: 'sprakmodeller',
      },
      {
        label: 'Kvalitet',
        text: 'Testsett med forventet strukturert svar, deterministiske dommere på skjema og innhold',
        block: 'evals',
      },
    ],
    examples: [
      'Hjelp til skjemautfylling i en Altinn Studio-app',
      '«Skriv klarere» i fagsystemet',
      'Automatisk forslag til kategori og saksbehandler',
      'Uttrekk av felter fra innsendte dokumenter',
      'Sammendrag øverst i en sak',
    ],
    cases: ['klarsprak-i-saksbehandling', 'altinn-skjemahjelp'],
  },
  {
    id: 'agenter',
    name: 'Agenter',
    nameEn: 'Agents',
    tagline: 'Utfører oppgaver i flere steg, med verktøy og menneske i løkken',
    intro:
      'En agent gjør mer enn å svare: den planlegger, bruker verktøy, leser resultatet og går videre til neste steg, til oppgaven er løst. Den kan kalles av et menneske eller av et annet system, og stopper for godkjenning der konsekvensen krever det.',
    description: [
      'Agenter passer for oppgaver som i dag krever at en person klikker seg gjennom flere systemer: hent saken, slå opp lignende saker, sjekk kapasitet, lag et sammendrag, foreslå fordeling. Kjernen i Genki kjører dette som en oppgave med logg over hvert steg, og en stegflyt kan ha faste godkjenningspunkter.',
      'Verktøy kommer fra MCP-servere, OpenAPI-beskrevne API-er og andre agenter over A2A. Agenten får bare verktøyene definisjonen gir den, hver med manifest som sier hva den får nå. Alt den gjør logges på oppgaven, og den kan avbrytes.',
      'Agenter kan være maskinelle: kalt fra arkivsystemet for hvert nytt dokument, autentisert med Maskinporten, uten en person i den andre enden. Da er menneske i løkken desto viktigere: agenten legger forslag, et menneske godkjenner.',
    ],
    fits: [
      'Oppgaven har flere steg på tvers av systemer',
      'Stegene kan beskrives, og resultatet kan kontrolleres',
      'Det finnes API-er eller MCP-verktøy for det agenten skal gjøre',
      'Et menneske kan godkjenne før noe irreversibelt skjer',
    ],
    avoid: [
      'Oppgaven er ett spørsmål og ett svar (da holder en assistent)',
      'Konsekvensene av en feil handling ikke kan fanges opp før de inntreffer',
      'Verktøyene mangler eller ikke kan avgrenses trygt',
    ],
    build: [
      {
        label: 'Arbeidsmåte',
        text: 'Agentløkke for åpne oppgaver, stegflyt for faste prosesser med godkjenning, fjernagent for egen motor',
        block: 'agent-runtime',
      },
      {
        label: 'Verktøy',
        text: 'MCP-servere, OpenAPI-verktøy og A2A-agenter, med manifest og egress-kontroll',
        block: 'verktoy',
      },
      {
        label: 'Identitet',
        text: 'Maskinporten og systembruker når agenten kalles maskinelt; Ansattporten når en person starter den',
        block: 'tilgangsstyring',
      },
      {
        label: 'Kanal',
        text: 'A2A fra andre systemer, MCP fra andre agenter, arbeidsflaten for ansatte',
        block: 'kanaler',
      },
      {
        label: 'Modell',
        text: 'En modell med gode verktøykall og resonnering; billigere modeller for enkle delsteg via KI-porten',
        block: 'sprakmodeller',
      },
      {
        label: 'Kvalitet',
        text: 'Testsett med forventet handlingsrekke, måling av hvor ofte mennesket endrer forslaget',
        block: 'evals',
      },
    ],
    examples: [
      'Agent i postmottaket som klassifiserer og foreslår fordeling',
      'Automatisk saksbehandling av en kommunal søknad, med saksbehandler som godkjenner',
      'Kodeagenter for utviklere, på åpen modell og felles infrastruktur i Norge',
      'Høringsagent som oppsummerer og sorterer innspill',
      'Saksstøtte i konsesjonsbehandling: komplett søknad, sorterte høringsinnspill, utkast til vurdering',
    ],
    cases: ['postmottak-agent', 'kommunal-soknad', 'nve-konsesjon', 'agentisk-utvikling'],
  },
];

export const serviceTypeById = (id: string) => serviceTypes.find((t) => t.id === id);
