export interface OrganisationProfile {
  orgNumber: string;
  name: string;
  role?: string;
  rights: string[];
}

export const organisationProfiles: OrganisationProfile[] = [
  {
    orgNumber: '999888777',
    name: 'Testetaten',
    role: 'Administrator',
    rights: [
      'Bruke tjenester',
      'Administrere tjenester',
      'Administrere datasett',
      'Registrere byggeklosser',
      'Se forbruk og kostnad',
    ],
  },
  {
    orgNumber: '999777666',
    name: 'Prøvekommunen',
    role: 'Utvikler',
    rights: ['Bruke tjenester', 'Administrere tjenester'],
  },
  {
    orgNumber: '999666555',
    name: 'Eksempeldirektoratet',
    role: 'Administrator',
    rights: ['Bruke tjenester', 'Administrere tjenester', 'Administrere datasett'],
  },
];

export const profileFor = (orgNumber: string, name: string): OrganisationProfile =>
  organisationProfiles.find((p) => p.orgNumber === orgNumber) ?? {
    orgNumber,
    name,
    rights: [],
  };

export const formatOrgNumber = (n: string) => n.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
