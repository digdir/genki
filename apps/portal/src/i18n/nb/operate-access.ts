import { defineNamespace } from '@genai/i18n';

const access = defineNamespace({
  title: 'Tilgang',
  lead: 'Rettighetene i portalen gis i Altinn av tilgangsstyreren i {tenant}.',
  grant: 'Gi en kollega tilgang',
  newTab: '(åpnes i ny fane)',
  openAltinn: 'Åpne Altinn',
  tabsLabel: 'Tilgang',
  tabPeople: 'Personer',
  tabServices: 'Tjenester',
  altinnErrorTitle: 'Fikk ikke kontakt med Altinn',
  altinnErrorStale:
    'Vi viser rettighetene slik de var {at}. Endringer gjort i Altinn etter det vises ikke ennå.',
  rightUseDesc:
    'Kan bruke tjenestene virksomheten har tatt i bruk, i chat eller fra egne systemer.',
  rightServicesDesc: 'Kan lage, endre, teste og publisere tjenester.',
  rightDatasetsDesc: 'Kan legge til kilder, laste opp filer og lese inn på nytt.',
  rightUsageDesc: 'Kan se tokenforbruk, kostnad og kvote for virksomheten.',
  searchPerson: 'Søk etter person',
  showWhoCan: 'Vis de som kan',
  filterAll: 'Alle',
  noRights: 'Ingen rettigheter',
  showing: 'Viser {shown} av {total} personer',
  noMatch: 'Ingen personer passer søket',
  resetFilter: 'Nullstill søk og filter',
  detailServices: 'Kan bruke disse tjenestene',
  detailSource: 'Hvor rettighetene kommer fra',
  allServices: 'Alle tjenestene. Tilgang kan ikke begrenses per tjeneste ennå.',
  needsUseRight: 'Ingen. Trenger «{right}» i Altinn.',
  missingRight: 'Mangler «{right}»',
  yourRights: 'Dine rettigheter',
  youHaveNoRights: 'Du har ingen rettigheter i portalen.',
  colleaguesInAltinn:
    'Portalen henter ikke kollegenes rettigheter fra Altinn ennå. Se hvem som har hvilke rettigheter i Altinn.',
  servicesLead: 'Alle med «{right}» kan bruke alle tjenestene.',
  loadingServices: 'Henter tjenestene',
  noServicesTitle: 'Ingen tjenester ennå',
  noServicesText: 'Tjenestene dere publiserer, vises her.',
  dialogWho: 'Hvem skal få tilgang?',
  dialogWhat: 'Hva skal kollegaen kunne gjøre?',
  dialogInAltinn: 'Denne rettigheten gis i Altinn av tilgangsstyreren deres. Send denne meldingen:',
  dialogPickOne: 'Velg minst én ting over, så skriver vi meldingen.',
  messageLabel: 'Meldingen til tilgangsstyreren',
  colleague: 'en kollega',
  message: {
    one: 'Hei!\nKan du gi {name} rettigheten {rights} for genki i Altinn, på vegne av {tenant} (org.nr. {org})?\n\nHilsen {sender}',
    other:
      'Hei!\nKan du gi {name} rettighetene {rights} for genki i Altinn, på vegne av {tenant} (org.nr. {org})?\n\nHilsen {sender}',
  },
  copyMessage: 'Kopier meldingen',
  copied: 'Kopiert. Lim inn meldingen i en e-post eller i Teams til tilgangsstyreren.',
  copyFailed: 'Fikk ikke kopiert. Merk teksten og kopier den selv.',
  discardAsk: 'Forkaste det du har skrevet?',
  discard: 'Forkast',
  keepWriting: 'Fortsett å skrive',
});

export const accessArea = { access } as const;
