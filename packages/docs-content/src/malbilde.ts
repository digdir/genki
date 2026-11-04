import type { ContentRoute } from './route.js';
import { links } from './blocks.js';

/**
 * Innholdet i målbildet (produktbladet): én side som viser hvem Genki er for, hva den består av,
 * og hva virksomhetene og fellesskapet får igjen. Hver boks lenker videre til siden som utdyper.
 * Teksten holdes kort; detaljene ligger på sidene det lenkes til.
 */

export type Point = {
  id: string;
  title: string;
  titleEn: string;
  text: string;
  /** Intern rute eller ekstern lenke. Uten lenke vises punktet som ren tekst. */
  to?: ContentRoute | string;
};

export const malbilde = {
  title: 'Målbilde for fellesløsning for generativ KI i offentlig sektor',
  subtitle:
    'En sikker, fleksibel og gjenbrukbar nasjonal fellesløsning som gjør det enklere for offentlige virksomheter å utvikle, ta i bruk og videreutvikle KI-baserte tjenester, sammen.',

  /** Målgruppene som bruker fellesløsningen. Hver lenker til en oversikt over virksomhetene (Wikipedia, SNL, regjeringen.no). */
  users: [
    {
      name: 'Kommuner',
      nameEn: 'Municipalities',
      to: 'https://no.wikipedia.org/wiki/Norges_kommuner',
      title: 'Norges kommuner (Wikipedia)',
    },
    {
      name: 'Direktorater',
      nameEn: 'Directorates',
      to: 'https://snl.no/direktorat',
      title: 'Liste over direktorater (Store norske leksikon)',
    },
    {
      name: 'Etater',
      nameEn: 'Agencies',
      to: 'https://www.regjeringen.no/no/org/etater-virksomheter-og-selskaper/id2520884/',
      title: 'Etater, virksomheter og selskaper (regjeringen.no)',
    },
    {
      name: 'Sykehus',
      nameEn: 'Hospitals',
      to: 'https://no.wikipedia.org/wiki/Liste_over_norske_sykehus',
      title: 'Liste over norske sykehus (Wikipedia)',
    },
    {
      name: 'Utdanning',
      nameEn: 'Education',
      to: 'https://no.wikipedia.org/wiki/Liste_over_universitet_og_h%C3%B8gskoler_i_Norge',
      title: 'Liste over universitet og høgskoler i Norge (Wikipedia)',
    },
    {
      name: 'Fylker',
      nameEn: 'Counties',
      to: 'https://no.wikipedia.org/wiki/Norges_fylker',
      title: 'Norges fylker (Wikipedia)',
    },
    {
      name: 'Forskning',
      nameEn: 'Research',
      to: 'https://no.wikipedia.org/wiki/Forskning',
      title: 'Forskning (Wikipedia)',
    },
  ] as { name: string; nameEn: string; to: string; title: string }[],
  usersLine: 'Bruker fellesløsningen for å utvikle og ta i bruk KI-tjenester',
  /** Linjen under fellesløsningen, med piler opp mot virksomhetene. */
  resultLine: 'Gir enklere, tryggere og mer kostnadseffektiv bruk av generativ KI',

  platformTitle: 'Nasjonal fellesløsning for generativ KI',
  platformSubtitle: 'Standardiserte, modulære og gjenbrukbare byggeklosser',
  infraText: 'En del av den nasjonale KI-infrastrukturen, i regi av Digdir.',

  /** De overordnede byggeklossene som er nye i Genki, i figurens rekkefølge. */
  newBlocks: ['kanaler', 'definisjoner', 'agent-runtime', 'rag', 'verktoy', 'evals', 'ki-gateway'],
  /** Fellesløsninger og plattform som gjenbrukes under. */
  reusedBlocks: ['autentisering', 'tilgangsstyring', 'plattform', 'sprakmodeller'],
  /** Regnekraften alt kjører på. */
  infraBlock: 'ki-infrastruktur',

  /** Prinsippene alt bygger på. */
  principles: [
    { id: 'kode', title: 'Åpen kildekode', titleEn: 'Open source', text: '', to: links.repo },
    { id: 'api', title: 'Åpne API-er', titleEn: 'Open APIs', text: '', to: links.api },
    {
      id: 'standarder',
      title: 'Etablerte standarder',
      titleEn: 'Established standards',
      text: '',
      to: links.adr,
    },
    {
      id: 'modular',
      title: 'Modulær arkitektur',
      titleEn: 'Modular architecture',
      text: '',
      to: { page: 'byggeklosser' },
    },
    {
      id: 'drift',
      title: 'Valgfri drift',
      titleEn: 'Hosting of your choice',
      text: 'Sky eller egen infrastruktur.',
      to: { page: 'byggeklosser', id: 'ki-infrastruktur' },
    },
  ] as Point[],

  /** Hva betyr dette i praksis? */
  practiceTitle: 'Hva betyr dette i praksis?',
  practiceLead: 'For en liten virksomhet',
  practiceIntro:
    'I stedet for å måtte skaffe kompetanse, velge modeller, etablere sikkerhetsmekanismer og bygge en teknisk plattform selv, kan virksomheten ta utgangspunkt i en felles nasjonal infrastruktur.',
  practice: [
    {
      id: 'ide',
      title: 'Idé',
      titleEn: 'Idea',
      text: 'Enklere å komme i gang.',
      to: { page: 'typer' },
    },
    {
      id: 'bygge',
      title: 'Bygge',
      titleEn: 'Build',
      text: 'Bruke byggeklosser og integrasjoner.',
      to: { page: 'kom-i-gang' },
    },
    {
      id: 'tjeneste',
      title: 'Tjeneste',
      titleEn: 'Service',
      text: 'Raskere fra idé til verdi.',
      to: { page: 'tjenester' },
    },
  ] as Point[],

  /** Hva den enkelte virksomheten får. */
  gains: [
    {
      id: 'kostnad',
      title: 'Lavere kostnader',
      titleEn: 'Lower costs',
      text: 'Mindre dobbeltarbeid og mindre behov for egen infrastruktur.',
      to: { page: 'byggeklosser', id: 'ki-infrastruktur' },
    },
    {
      id: 'fart',
      title: 'Raskere innføring av KI',
      titleEn: 'Faster adoption of AI',
      text: 'Virksomhetene kommer raskere fra idé til tjeneste. Terskelen senkes.',
      to: { page: 'kom-i-gang' },
    },
    {
      id: 'sikkerhet',
      title: 'Bedre sikkerhet og ansvarlighet',
      titleEn: 'Better security and accountability',
      text: 'Felles sikkerhetsmekanismer, logging og styring. Håndterer ulike krav til sikkerhet og informasjonsbehandling, inkludert norsk språk, etikk og kultur.',
      to: { page: 'byggeklosser', id: 'evals' },
    },
    {
      id: 'innovasjon',
      title: 'Mer innovasjon og skalering',
      titleEn: 'More innovation and scale',
      text: 'Mer tid til å utvikle nye tjenester og forbedre interne prosesser. Det som virker ett sted, kan tas i bruk av flere. Felles infrastruktur utvikles i samarbeid og kan brukes i skyen eller som åpen kildekode.',
      to: { page: 'typer' },
    },
    {
      id: 'valgfrihet',
      title: 'Større valgfrihet',
      titleEn: 'More freedom of choice',
      text: 'Åpne standarder og tilgang til flere modeller og leverandører reduserer teknologisk innlåsing. Raskere utbredelse av europeiske og norske modeller.',
      to: { page: 'byggeklosser', id: 'ki-gateway' },
    },
    {
      id: 'handlingsrom',
      title: 'Større digitalt handlingsrom og beredskap',
      titleEn: 'More digital autonomy and preparedness',
      text: 'Nasjonal kompetanse, åpen kildekode og mulighet til å bruke ulike modeller gir større kontroll over egen utvikling.',
      to: { page: 'byggeklosser', id: 'sprakmodeller' },
    },
    {
      id: 'innbyggere',
      title: 'Bedre tjenester for innbyggerne',
      titleEn: 'Better services for citizens',
      text: 'Flere virksomheter kan bruke KI til å forbedre tjenester og løse oppgaver på nye måter.',
      to: { page: 'tjenester' },
    },
  ] as Point[],

  /** Hva sektoren får samlet. */
  effects: [
    {
      id: 'trygg',
      title: 'Trygg og ansvarlig KI-bruk',
      titleEn: 'Safe and responsible use of AI',
      text: 'Bedre kontroll, felles sikkerhet og regelverkshåndtering.',
      to: { page: 'byggeklosser', id: 'tilgangsstyring' },
    },
    {
      id: 'gjenbruk',
      title: 'Økt gjenbruk',
      titleEn: 'More reuse',
      text: 'Flere virksomheter bruker det samme, og på tvers av sektoren.',
      to: { page: 'byggeklosser' },
    },
    {
      id: 'samarbeid',
      title: 'Styrket samarbeid',
      titleEn: 'Stronger collaboration',
      text: 'Deling av kunnskap, kompetanse og løsninger.',
      to: links.repo,
    },
    {
      id: 'utvikling',
      title: 'Raskere utvikling',
      titleEn: 'Faster development',
      text: 'Kortere vei fra behov til tjeneste.',
      to: { page: 'tjenester' },
    },
    {
      id: 'kompetanse',
      title: 'Styrket kompetanse',
      titleEn: 'Stronger expertise',
      text: 'Læring, deling og felles utvikling på tvers av offentlig sektor.',
      to: links.adr,
    },
    {
      id: 'valgfrihet',
      title: 'Større handlingsrom',
      titleEn: 'More room to act',
      text: 'Valgfrihet i modeller, teknologier og leverandører.',
      to: { page: 'byggeklosser', id: 'sprakmodeller' },
    },
    {
      id: 'verdi',
      title: 'Mer verdi for fellesskapet',
      titleEn: 'More value for society',
      text: 'Bedre tjenester for innbyggere og næringsliv, og mer effektive arbeidsprosesser i sektoren.',
      to: { page: 'typer' },
    },
  ] as Point[],

  en: {
    title: 'Target picture for a shared platform for generative AI in the public sector',
    subtitle:
      'A secure, flexible and reusable national shared platform that makes it easier for public agencies to develop, adopt and further develop AI-based services, together.',
    usersLine: 'Use the shared platform to develop and adopt AI services',
    resultLine: 'Gives simpler, safer and more cost-effective use of generative AI',
    platformTitle: 'National shared platform for generative AI',
    platformSubtitle: 'Standardised, modular and reusable building blocks',
    practiceTitle: 'What does this mean in practice?',
    practiceLead: 'For a small agency',
    footer: 'Together we solve shared needs and free up time to create better services.',
    footerSub: 'One shared platform. More possibilities.',
  },

  footer: 'Sammen løser vi felles behov og frigjør tid til å skape bedre tjenester.',
  footerSub: 'En felles løsning. Større muligheter.',
};
