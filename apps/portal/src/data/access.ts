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

export interface Group {
  name: string;
  members: string[];
}

export const groups: Record<string, Group> = {
  tilskudd: { name: 'Saksbehandlere tilskudd', members: ['per', 'ola', 'sara'] },
  komm: { name: 'Kommunikasjon', members: ['line', 'tor'] },
  utv: { name: 'Utviklere', members: ['jonas', 'kari'] },
  nyn: { name: 'Prosjekt nynorsk', members: [] },
};

export interface Resource {
  id: string;
  kind: 'service' | 'dataset';
  name: string;
  tag: string;
  mode: 'all' | 'selected';
  who: string[];
  locked?: string;
}

export const resources: Resource[] = [
  {
    id: 'rapportassistenten',
    kind: 'service',
    name: 'Rapportassistenten',
    tag: 'I bruk',
    mode: 'all',
    who: [],
  },
  {
    id: 'vedtaksutkast',
    kind: 'service',
    name: 'Vedtaksutkast',
    tag: 'I bruk',
    mode: 'selected',
    who: ['g:tilskudd'],
  },
  {
    id: 'soknadsuttrekk',
    kind: 'service',
    name: 'Søknadsuttrekk',
    tag: 'I bruk',
    mode: 'selected',
    who: ['g:tilskudd', 'p:ingrid'],
  },
  {
    id: 'nettsider-nynorsk',
    kind: 'service',
    name: 'Nettsider på nynorsk',
    tag: 'I bruk',
    mode: 'selected',
    who: ['g:komm'],
  },
  {
    id: 'horingsoppsummering',
    kind: 'service',
    name: 'Høringsoppsummering',
    tag: 'I test',
    mode: 'selected',
    who: ['p:per', 'p:ahmed'],
  },
  {
    id: 'motereferat',
    kind: 'service',
    name: 'Møtereferat',
    tag: 'Utkast',
    mode: 'selected',
    who: [],
  },
  {
    id: 'kudos',
    kind: 'dataset',
    name: 'Kudos-rapporter',
    tag: 'Åpne data',
    mode: 'all',
    who: [],
    locked: 'Rapportene i Kudos er offentlige. Alle med «Bruke tjenester» kan søke i dem.',
  },
  {
    id: 'tilsyn',
    kind: 'dataset',
    name: 'Tilsynsrapporter 2025',
    tag: '',
    mode: 'selected',
    who: ['g:tilskudd', 'p:kari'],
  },
  { id: 'web', kind: 'dataset', name: 'Nettsidene til Testetaten', tag: '', mode: 'all', who: [] },
  { id: 'veil', kind: 'dataset', name: 'Veiledere og rundskriv', tag: '', mode: 'all', who: [] },
  {
    id: 'stats',
    kind: 'dataset',
    name: 'Statsbudsjettet 2026',
    tag: 'Delt av Eksempeldirektoratet',
    mode: 'all',
    who: [],
    locked:
      'Datasettet eies av Eksempeldirektoratet, som har delt det med alle statlige virksomheter.',
  },
  {
    id: 'hor',
    kind: 'dataset',
    name: 'Høring 2026/7',
    tag: '',
    mode: 'selected',
    who: ['p:per', 'p:ahmed', 'p:tor'],
  },
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

export const altinnSync = { fetchedAt: 'i dag kl. 10.52', lastGoodAt: 'i dag kl. 08.14' };
