export interface SharedCapability {
  id: string;
  alias: string;
  tool: string;
  name: string;
  version: string;
  does: string;
  long: string;
  longLang?: 'nn';
  input: string;
  output: string;
  model: string;
  location: string;
  score: number;
  scoreNote?: string;
  scoreAlert?: string;
  price: string;
  priceNote: string;
  optionLabel: string;
  options: string[];
  multi?: boolean;
  kind: 'text' | 'audio';
  inputLabel?: string;
  used?: string;
  sample?: string;
  result?: string;
  resultLang?: 'nn';
  fields?: [string, string][];
  notes: string[];
  notesLang?: 'nn';
  seconds: string;
  tokens: string;
  body: Record<string, unknown>;
}

export const sharedCapabilities: SharedCapability[] = [
  {
    id: 'klarsprak',
    alias: 'klar',
    tool: 'digdir.klarsprak',
    name: 'Klarspråk',
    version: '2.3',
    does: 'Skriver om tekst så den blir lettere å forstå, uten å endre innholdet.',
    long: 'Skriver om brev, vedtak og nettekster etter rådene fra Språkrådet: korte setninger, aktive verb og det viktigste først. Fagbegreper som må stå, beholdes og forklares.',
    input: 'Tekst eller Word-fil',
    output: 'Omskrevet tekst og liste over endringer',
    model: 'Borealis-27B',
    location: 'Norge',
    score: 81,
    scoreNote: 'Var 89 for to uker siden',
    scoreAlert:
      'Kvaliteten falt fra 89 til 79 etter at modellen ble oppdatert 29. september, og er nå 81. Digdir undersøker. Tjenester som bruker klarspråk, virker som før.',
    price: '7,50 kr',
    priceNote: 'Brev på 1 side',
    optionLabel: 'Målgruppe',
    options: ['Innbyggere', 'Fagpersoner'],
    kind: 'text',
    inputLabel: 'Tekst du vil skrive om',
    sample:
      'Det vises til Deres søknad mottatt 12.09.2026. Etter en helhetsvurdering av de foreliggende opplysninger har Testetaten kommet til at vilkårene for innvilgelse av tilskudd ikke anses å være oppfylt, jf. forskriftens § 4 første ledd.',
    result:
      'Vi har behandlet søknaden din fra 12. september 2026. Du får ikke tilskudd.\n\nFor å få tilskudd må dere oppfylle vilkårene i § 4 første ledd i forskriften. Vi har gått gjennom opplysningene i søknaden, og de viser at dere ikke oppfyller disse vilkårene.',
    notes: [
      'Skrev det viktigste først: at søkeren ikke får tilskudd.',
      'Byttet «Deres» med «du» og passive setninger med aktive.',
      'Beholdt henvisningen til § 4 første ledd.',
    ],
    seconds: '2,1 s',
    tokens: '1 240',
    body: { malgruppe: 'innbyggere' },
  },
  {
    id: 'nynorsk',
    alias: 'nyn',
    tool: 'digdir.nynorsk',
    name: 'Bokmål til nynorsk',
    version: '1.8',
    does: 'Oversetter tekst fra bokmål til nynorsk etter gjeldende rettskriving.',
    long: 'Set om tekst frå bokmål til nynorsk. Følgjer rettskrivinga frå Språkrådet og ei felles ordliste for offentleg sektor. Dere kan leggje til eigne fagord som alltid skal omsetjast likt.',
    longLang: 'nn',
    input: 'Tekst, Word eller HTML',
    output: 'Tekst på nynorsk i samme format',
    model: 'Borealis-27B',
    location: 'Norge',
    score: 87,
    price: '8 kr',
    priceNote: 'Nettside på 600 ord',
    optionLabel: 'Former',
    options: ['Moderat nynorsk', 'Tradisjonell nynorsk'],
    kind: 'text',
    inputLabel: 'Tekst på bokmål',
    used: 'Brukes i 1 av tjenestene deres',
    sample:
      'Du kan søke om tilskudd hvis organisasjonen din har aktiviteter for barn og unge. Søknadsfristen er 1. mars. Vi behandler søknadene i den rekkefølgen de kommer inn.',
    result:
      'Du kan søkje om tilskot dersom organisasjonen din har aktivitetar for born og unge. Søknadsfristen er 1. mars. Vi behandlar søknadene i den rekkjefølgja dei kjem inn.',
    resultLang: 'nn',
    notes: ['Brukte «tilskot» frå den felles ordlista for offentleg sektor.'],
    notesLang: 'nn',
    seconds: '1,4 s',
    tokens: '610',
    body: { former: 'moderat' },
  },
  {
    id: 'oppsummering',
    alias: 'sum',
    tool: 'digdir.oppsummering',
    name: 'Oppsummering',
    version: '3.0',
    does: 'Lager korte sammendrag av lange dokumenter, med henvisning til hvor hvert punkt står.',
    long: 'Lager sammendrag av rapporter, høringssvar og saksdokumenter. Hvert punkt viser til siden eller avsnittet det bygger på, så det er lett å kontrollere.',
    input: 'Tekst, PDF eller Word, inntil 300 sider',
    output: 'Sammendrag med henvisninger',
    model: 'Borealis-27B',
    location: 'Norge',
    score: 84,
    price: '40 kr',
    priceNote: 'Rapport på 30 sider',
    optionLabel: 'Lengde',
    options: ['Kort', 'Middels', 'Lang'],
    kind: 'text',
    inputLabel: 'Tekst du vil oppsummere',
    sample:
      'Evalueringen viser at den digitale veiledningen har redusert antall telefonhenvendelser med 18 prosent fra 2022 til 2024. Samtidig oppgir brukerne at de ofte må gjenta opplysninger når de går fra chat til telefon. Brukere over 67 år bruker i liten grad de digitale kanalene. Evaluator anbefaler at opplysninger fra chat følger med når samtalen settes over til en saksbehandler, og at det beholdes en telefonlinje med kort ventetid.',
    result:
      '• Telefonhenvendelsene gikk ned med 18 prosent fra 2022 til 2024 etter at digital veiledning ble innført. (avsnitt 1)\n• Brukerne må ofte gjenta opplysninger når de går fra chat til telefon. (avsnitt 1)\n• Brukere over 67 år bruker lite de digitale kanalene. (avsnitt 1)\n• Anbefaling: la opplysninger fra chat følge med til saksbehandler, og behold en telefonlinje med kort ventetid. (avsnitt 1)',
    notes: [],
    seconds: '3,2 s',
    tokens: '1 980',
    body: { lengde: 'kort' },
  },
  {
    id: 'anonymisering',
    alias: 'anon',
    tool: 'digdir.anonymisering',
    name: 'Anonymisering',
    version: '1.4',
    does: 'Finner og fjerner navn, fødselsnumre, adresser og andre personopplysninger.',
    long: 'Finner personopplysninger i tekst og dokumenter og bytter dem ut med en merkelapp. Dere velger hva som skal fjernes. Resultatet viser hva som ble funnet, så en person kan kontrollere det.',
    input: 'Tekst, PDF eller Word',
    output: 'Anonymisert tekst og liste over funn',
    model: 'Qwen3.8-27B',
    location: 'Norge',
    score: 95,
    price: '12 kr',
    priceNote: 'Dokument på 3 sider',
    optionLabel: 'Fjern',
    options: ['Navn', 'Fødselsnummer', 'Adresse', 'Telefon og e-post'],
    multi: true,
    kind: 'text',
    inputLabel: 'Tekst med personopplysninger',
    sample:
      'Kari Hansen (fødselsnummer 01017012345) bor i Storgata 12, 0155 Oslo. Hun ringte 912 34 567 den 3. oktober og ba om at saken ble sendt til kari.hansen@example.no.',
    result:
      '[NAVN] (fødselsnummer [FØDSELSNUMMER]) bor i [ADRESSE]. Hun ringte [TELEFON] den 3. oktober og ba om at saken ble sendt til [E-POST].',
    notes: [
      '1 navn',
      '1 fødselsnummer',
      '1 adresse',
      '1 telefonnummer og 1 e-postadresse',
      'Datoen ble beholdt fordi den ikke peker på en person.',
    ],
    seconds: '1,1 s',
    tokens: '720',
    body: { fjern: ['navn', 'fodselsnummer', 'adresse', 'kontakt'] },
  },
  {
    id: 'transkribering',
    alias: 'trans',
    tool: 'digdir.transkribering',
    name: 'Transkribering',
    version: '2.0',
    does: 'Gjør lydopptak om til tekst på bokmål eller nynorsk, med hvem som snakker.',
    long: 'Gjør lydopptak av møter og intervjuer om til tekst. Skiller mellom de som snakker, og setter inn tidspunkt. Kan kombineres med oppsummering for å lage møtereferat.',
    input: 'Lydfil: MP3, M4A eller WAV',
    output: 'Tekst med talere og tidspunkt',
    model: 'NB-Whisper large',
    location: 'Norge',
    score: 91,
    price: '900 kr',
    priceNote: 'Opptak på 30 minutter',
    optionLabel: 'Skriv på',
    options: ['Bokmål', 'Nynorsk'],
    kind: 'audio',
    used: 'Brukes i 1 av tjenestene deres',
    result:
      '[00:00] Taler 1: Da starter vi. Første sak er budsjettet for neste år.\n[00:06] Taler 2: Vi har fått et foreløpig tall fra departementet, og det er litt lavere enn i år.\n[00:14] Taler 1: Hvor mye lavere?\n[00:16] Taler 2: Omtrent fire prosent. Vi må se på hva vi kan utsette.',
    notes: ['2 talere funnet', 'Opptaket er 2 minutter'],
    seconds: '9,8 s',
    tokens: '–',
    body: { sprak: 'nb', talere: true },
  },
  {
    id: 'hent_felter',
    alias: 'felt',
    tool: 'digdir.hent_felter',
    name: 'Hent ut opplysninger',
    version: '1.2',
    does: 'Leser dokumenter og fyller ut feltene dere definerer, som navn, beløp og datoer.',
    long: 'Leser søknader, fakturaer og skjemaer og fyller ut feltene dere definerer. Leser også skannede dokumenter. Felter den er usikker på, blir merket, så en person kan sjekke dem.',
    input: 'PDF, Word eller bilde',
    output: 'Felter med verdi og hvor sikker den er',
    model: 'Qwen3.8-27B',
    location: 'Norge',
    score: 83,
    scoreNote: 'Var 86 for to uker siden',
    price: '19 kr',
    priceNote: 'Søknad på 4 sider',
    optionLabel: 'Felter',
    options: ['Søknad om tilskudd', 'Faktura', 'Egne felter'],
    kind: 'text',
    inputLabel: 'Tekst fra dokumentet',
    used: 'Brukes i 1 av tjenestene deres',
    sample:
      'Søknad om tilskudd 2026\nSøker: Elvebakken Musikkorps\nOrganisasjonsnummer: 944 556 677\nKontaktperson: Ingrid Moen\nVi søker om 1 200 000 kroner til nye instrumenter.\nVedlegg: budsjett, årsregnskap',
    fields: [
      ['Søkers navn', 'Elvebakken Musikkorps'],
      ['Organisasjonsnummer', '944 556 677'],
      ['Omsøkt beløp', '1 200 000 kr'],
      ['Mangler vedlegg', 'Ja'],
      ['Manglende vedlegg', 'Vedtekter'],
    ],
    notes: [
      'Alle felter har høy sikkerhet.',
      'Vedtekter er påkrevd for søknader over 500 000 kroner.',
    ],
    seconds: '2,4 s',
    tokens: '1 310',
    body: { felter: 'soknad_tilskudd' },
  },
];

export const findCapability = (key: string) =>
  sharedCapabilities.find((c) => c.id === key || c.alias === key || c.tool === key);
