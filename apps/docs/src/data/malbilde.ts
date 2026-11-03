import type { Route } from '../router';
import { links } from './blocks';

/**
 * Innholdet i målbildet (produktbladet): én side som viser hvem Genki er for, hva den består av,
 * og hva virksomhetene og fellesskapet får igjen. Hver boks lenker videre til siden som utdyper.
 * Teksten holdes kort; detaljene ligger på sidene det lenkes til.
 */

export type Point = {
  id: string;
  title: string;
  text: string;
  /** Intern rute eller ekstern lenke. Uten lenke vises punktet som ren tekst. */
  to?: Route | string;
};

export const malbilde = {
  title: 'Målbilde for fellesløsning for generativ KI i offentlig sektor',
  subtitle:
    'En sikker, fleksibel og gjenbrukbar nasjonal fellesløsning som gjør det enklere for offentlige virksomheter å utvikle, ta i bruk og videreutvikle KI-baserte tjenester – sammen.',

  /** Hvem som bruker fellesløsningen. Hver lenker til en oversikt over virksomhetene (Wikipedia, SNL, regjeringen.no). */
  users: [
    {
      name: 'Kommuner',
      to: 'https://no.wikipedia.org/wiki/Norges_kommuner',
      title: 'Norges kommuner (Wikipedia)',
    },
    {
      name: 'Direktorater',
      to: 'https://snl.no/direktorat',
      title: 'Liste over direktorater (Store norske leksikon)',
    },
    {
      name: 'Etater',
      to: 'https://www.regjeringen.no/no/org/etater-virksomheter-og-selskaper/id2520884/',
      title: 'Etater, virksomheter og selskaper (regjeringen.no)',
    },
    {
      name: 'Sykehus',
      to: 'https://no.wikipedia.org/wiki/Liste_over_norske_sykehus',
      title: 'Liste over norske sykehus (Wikipedia)',
    },
    {
      name: 'Utdanning',
      to: 'https://no.wikipedia.org/wiki/Liste_over_universitet_og_h%C3%B8gskoler_i_Norge',
      title: 'Liste over universitet og høgskoler i Norge (Wikipedia)',
    },
    {
      name: 'Fylker',
      to: 'https://no.wikipedia.org/wiki/Norges_fylker',
      title: 'Norges fylker (Wikipedia)',
    },
  ] as { name: string; to: string; title: string }[],
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
    { id: 'kode', title: 'Åpen kildekode', text: '', to: links.repo },
    { id: 'api', title: 'Åpne API-er', text: '', to: links.api },
    { id: 'standarder', title: 'Etablerte standarder', text: '', to: links.adr },
    { id: 'modular', title: 'Modulær arkitektur', text: '', to: { page: 'byggeklosser' } },
    {
      id: 'drift',
      title: 'Valgfri drift',
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
    { id: 'ide', title: 'Idé', text: 'Enklere å komme i gang.', to: { page: 'typer' } },
    {
      id: 'bygge',
      title: 'Bygge',
      text: 'Bruke byggeklosser og integrasjoner.',
      to: { page: 'kom-i-gang' },
    },
    {
      id: 'tjeneste',
      title: 'Tjeneste',
      text: 'Raskere fra idé til verdi.',
      to: { page: 'tjenester' },
    },
  ] as Point[],

  /** Hva den enkelte virksomheten får. */
  gains: [
    {
      id: 'kostnad',
      title: 'Lavere kostnader',
      text: 'Mindre dobbeltarbeid og mindre behov for egen infrastruktur.',
      to: { page: 'byggeklosser', id: 'ki-infrastruktur' },
    },
    {
      id: 'fart',
      title: 'Raskere innføring av KI',
      text: 'Virksomhetene kommer raskere fra idé til tjeneste. Terskelen senkes.',
      to: { page: 'kom-i-gang' },
    },
    {
      id: 'sikkerhet',
      title: 'Bedre sikkerhet og ansvarlighet',
      text: 'Felles sikkerhetsmekanismer, logging og styring. Håndterer ulike krav til sikkerhet og informasjonsbehandling, inkludert norsk språk, etikk og kultur.',
      to: { page: 'byggeklosser', id: 'evals' },
    },
    {
      id: 'innovasjon',
      title: 'Mer innovasjon',
      text: 'Mer tid til å utvikle nye tjenester og forbedre interne prosesser. Felles infrastruktur utvikles i samarbeid og kan brukes i skyen eller som åpen kildekode.',
      to: { page: 'typer' },
    },
    {
      id: 'valgfrihet',
      title: 'Større valgfrihet',
      text: 'Åpne standarder og tilgang til flere modeller og leverandører reduserer teknologisk innlåsing. Raskere utbredelse av europeiske og norske modeller.',
      to: { page: 'byggeklosser', id: 'ki-gateway' },
    },
    {
      id: 'handlingsrom',
      title: 'Større digitalt handlingsrom og beredskap',
      text: 'Nasjonal kompetanse, åpen kildekode og mulighet til å bruke ulike modeller gir større kontroll over egen utvikling.',
      to: { page: 'byggeklosser', id: 'sprakmodeller' },
    },
    {
      id: 'innbyggere',
      title: 'Bedre tjenester for innbyggerne',
      text: 'Flere virksomheter kan bruke KI til å forbedre tjenester og løse oppgaver på nye måter.',
      to: { page: 'tjenester' },
    },
  ] as Point[],

  /** Hva sektoren får samlet. */
  effects: [
    {
      id: 'trygg',
      title: 'Trygg og ansvarlig KI-bruk',
      text: 'Bedre kontroll, felles sikkerhet og regelverkshåndtering.',
      to: { page: 'byggeklosser', id: 'tilgangsstyring' },
    },
    {
      id: 'gjenbruk',
      title: 'Økt gjenbruk',
      text: 'Flere virksomheter bruker det samme, og på tvers av sektoren.',
      to: { page: 'byggeklosser' },
    },
    {
      id: 'samarbeid',
      title: 'Styrket samarbeid',
      text: 'Deling av kunnskap, kompetanse og løsninger.',
      to: links.repo,
    },
    {
      id: 'utvikling',
      title: 'Raskere utvikling',
      text: 'Kortere vei fra behov til tjeneste.',
      to: { page: 'tjenester' },
    },
    {
      id: 'kompetanse',
      title: 'Styrket kompetanse',
      text: 'Læring, deling og felles utvikling på tvers av offentlig sektor.',
      to: links.adr,
    },
    {
      id: 'valgfrihet',
      title: 'Større handlingsrom',
      text: 'Valgfrihet i modeller, teknologier og leverandører.',
      to: { page: 'byggeklosser', id: 'sprakmodeller' },
    },
    {
      id: 'verdi',
      title: 'Mer verdi for fellesskapet',
      text: 'Bedre tjenester for innbyggere og næringsliv, og mer effektive arbeidsprosesser i sektoren.',
      to: { page: 'typer' },
    },
  ] as Point[],

  footer: 'Sammen løser vi felles behov – og frigjør tid til å skape bedre tjenester.',
  footerSub: 'En felles løsning. Større muligheter.',
};
