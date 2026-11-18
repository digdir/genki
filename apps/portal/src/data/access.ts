export type RightKey = 'use' | 'services' | 'datasets' | 'usage';

export const rights: { key: RightKey; label: string; description: string }[] = [
  {
    key: 'use',
    label: 'Bruke tjenester',
    description:
      'Kan bruke tjenestene virksomheten har tatt i bruk, i chat eller fra egne systemer.',
  },
  {
    key: 'services',
    label: 'Administrere tjenester',
    description: 'Kan lage, endre, teste og publisere tjenester, og styre tilgangen til dem.',
  },
  {
    key: 'datasets',
    label: 'Administrere datasett',
    description: 'Kan legge til datasett, endre kilder og styre hvem som kan søke i dem.',
  },
  {
    key: 'usage',
    label: 'Se forbruk og kostnad',
    description: 'Kan se tokenforbruk, kostnad og kvote for virksomheten.',
  },
];

export interface Person {
  id: string;
  name: string;
  unit: string;
  rights: RightKey[];
  source: string;
}

export const people: Person[] = [
  {
    id: 'kari',
    name: 'Kari Nordmann',
    unit: 'Seksjon for digitalisering',
    rights: ['use', 'services', 'datasets', 'usage'],
    source: 'Gitt av Mona Hauge i Altinn 12. mars 2026. Kari er også tilgangsstyrer.',
  },
  {
    id: 'mona',
    name: 'Mona Hauge',
    unit: 'Avdelingsdirektør, virksomhetsstyring',
    rights: ['usage'],
    source: 'Via rollen «Daglig leder» i Altinn.',
  },
  {
    id: 'per',
    name: 'Per Hansen',
    unit: 'Seksjon for tilskudd',
    rights: ['use', 'services'],
    source: 'Gitt av Kari Nordmann i Altinn 2. april 2026.',
  },
  {
    id: 'jonas',
    name: 'Jonas Lie',
    unit: 'Utvikling',
    rights: ['use', 'services'],
    source: 'Gitt av Kari Nordmann i Altinn 2. april 2026.',
  },
  {
    id: 'ingrid',
    name: 'Ingrid Berg',
    unit: 'Arkiv og dokumentasjon',
    rights: ['use', 'datasets'],
    source: 'Gitt av Kari Nordmann i Altinn 20. mai 2026.',
  },
  {
    id: 'ahmed',
    name: 'Ahmed Ali',
    unit: 'Økonomi',
    rights: ['use', 'usage'],
    source: 'Gitt av Mona Hauge i Altinn 9. juni 2026.',
  },
  {
    id: 'ola',
    name: 'Ola Nordmann',
    unit: 'Seksjon for tilskudd',
    rights: ['use'],
    source: 'Gitt av Per Hansen i Altinn 3. september 2026.',
  },
  {
    id: 'sara',
    name: 'Sara Nilsen',
    unit: 'Seksjon for tilskudd',
    rights: ['use'],
    source: 'Gitt av Per Hansen i Altinn 3. september 2026.',
  },
  {
    id: 'line',
    name: 'Line Johansen',
    unit: 'Kommunikasjon',
    rights: ['use'],
    source: 'Gitt av Kari Nordmann i Altinn 14. august 2026.',
  },
  {
    id: 'tor',
    name: 'Tor Eriksen',
    unit: 'Kommunikasjon',
    rights: [],
    source: 'Hadde «Bruke tjenester» til 30. september 2026. Fjernet av Kari Nordmann.',
  },
];

export interface ExampleService {
  id: string;
  name: string;
  tag: string;
}

export const exampleServices: ExampleService[] = [
  { id: 'rapportassistenten', name: 'Rapportassistenten', tag: 'I bruk' },
  { id: 'vedtaksutkast', name: 'Vedtaksutkast', tag: 'I bruk' },
  { id: 'soknadsuttrekk', name: 'Søknadsuttrekk', tag: 'I bruk' },
  { id: 'nettsider-nynorsk', name: 'Nettsider på nynorsk', tag: 'I bruk' },
  { id: 'horingsoppsummering', name: 'Høringsoppsummering', tag: 'I test' },
  { id: 'motereferat', name: 'Møtereferat', tag: 'Utkast' },
];

export const accessManagers = [
  {
    name: 'Kari Nordmann',
    unit: 'Seksjon for digitalisering',
    email: 'kari.nordmann@testetaten.example.no',
  },
  {
    name: 'Mona Hauge',
    unit: 'Avdelingsdirektør, virksomhetsstyring',
    email: 'mona.hauge@testetaten.example.no',
  },
];

export const altinnSync = { lastGoodAt: 'i dag kl. 08.14' };
