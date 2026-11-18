import { defineNamespace } from '@genai/i18n';

export const services = defineNamespace({
  assistantRefused:
    'Byggeassistenten er slått av for virksomheten. En administrator kan slå den på under Innstillinger. Skjemaet virker som vanlig.',
  assistantUnavailable:
    'Assistenten svarer ikke akkurat nå. Skjemaet virker som vanlig, og ingenting er endret. Prøv igjen om litt.',
  assistantNoModel:
    'Ingen modell med verktøystøtte er tilgjengelig for byggeassistenten. En administrator kan velge modell under Innstillinger.',
  assistantBudget:
    'Assistenten har brukt opp {tokens} tokens for i dag. Kvoten fornyes kl. 00.00. Skjemaet virker som vanlig.',
  assistantNotPublished:
    'Byggeassistenten er ikke publisert på plattformen ennå. Skjemaet virker som vanlig.',
  assistantNeedsRight: 'Må godkjennes av noen med rettigheten «{right}».',
  optimiserNotPublished: 'Forbedringstjenesten er ikke publisert på plattformen ennå.',
  improvementLanguageUnknown: 'Språket må være nb, nn eller en.',
  improvementNoLanguageText:
    'Tjenesten har ingen egen tekst for språket «{language}». Skriv en under Instruksjoner først.',
  platformStrategyOnly: 'Bare plattformen kan publisere tjenester med denne strategien.',
  rightUseServices: 'Bruke tjenester',
  rightManageServices: 'Administrere tjenester',
  rightManageDatasets: 'Administrere datasett',
  rightRegisterBuildingBlocks: 'Registrere byggeklosser',
  rightViewUsage: 'Se forbruk og kostnad',
  blockNeedsApproval: '«{name}» krever godkjenning før den kan brukes hos virksomheten.',
  notAllowedHere: '{id} er ikke tillatt hos dere.',
  needsApproval: '{id} krever godkjenning før den kan brukes.',
  notCounted: 'Ingenting er lagret, og kjøringen er ikke telt i kvoten.',
  modelUnavailable:
    'Vi fikk ikke svar fra modellen. Ingenting er lagret, og kjøringen er ikke telt i kvoten.',
  failedNotCounted: '{reason} Ingenting er lagret, og kjøringen er ikke telt i kvoten.',
  extractInstructions: 'Hent ut opplysningene fra dokumentet.',
  answerInstructions: 'Svar kort og presist på norsk.',
  testedOnDraft: 'Testsettet har kjørt på utkastet',
  runOnDraft: 'Kjør testsettet på denne versjonen av utkastet.',
  passRate: 'Minst {percent} prosent av testtilfellene består',
  passedOf: '{passed} av {total} bestått',
  noDraftRun: 'Ingen testkjøring på utkastet.',
  mustReject: 'Alle tilfeller som skal avvises, blir avvist',
  notRejected: {
    one: '{count} tilfelle ble ikke avvist',
    other: '{count} tilfeller ble ikke avvist',
  },
  publishedTools: 'Verktøyene peker på publiserte versjoner',
  placeNorway: 'i Norge',
  placeEu: 'i EU/EØS',
  placeGlobal: 'utenfor EU/EØS',
  modelRetired: 'Modellen {id} er tatt ut av bruk.',
  modelReclassified:
    'Modellen {id} er nå klassifisert til å behandle data {place}, men tjenesten krever {required}.',
  primaryRetired: 'Modellen tjenesten bruker er tatt ut av bruk ({id}).',
  retired: 'Modellen tjenesten bruker er tatt ut av bruk',
  engineHttp: 'Søk over HTTP',
  engineMcp: 'Søk gjennom MCP',
  templateName: 'Ny tjeneste',
  templatePurpose: 'Beskriv hva tjenesten skal gjøre',
  pluginBuiltinTools: 'Innebygde verktøy',
  pluginMemoryBlob: 'Minnelager',
  pluginDiskBlob: 'Fillager på disk',
  connectorDataset: 'Rader fra {table}, lest av koblingen for {service}.',
  connectorName: 'Kobling for {service}',
  seedReason: 'Lastet fra den lokale konfigurasjonen',
  archivedByTenant: 'Tjenesten er arkivert og kan ikke kjøres.',
  pausedByTenant: 'Tjenesten er satt på pause. Begrunnelse: {reason}',
  variantAnswer: 'Svar med kilder',
  variantDefault: 'Standard',
  variantRetrieveOnly: 'Bare søk',
  boundOutside: 'API-nøkkelen er knyttet til tjenesten {service} og kan ikke bruke {name}.',
  devLoginUnknownPerson: 'Fant ikke testpersonen',
  environmentInvalid:
    '`GenAI-Environment` må være et miljønavn med små bokstaver, sifre og bindestrek, for eksempel test.',
  environmentNotAllowed: 'Nøkkelen eller frontenden har ikke tilgang til miljøet {environment}.',
  environmentMissing: 'Tjenesten {service} har ikke miljøet {environment}.',
  environmentName:
    'Miljønavnet må ha små bokstaver, sifre og bindestrek og begynne med en bokstav.',
  environmentExists: 'Tjenesten har allerede miljøet {environment}.',
  environmentProdFixed: 'prod finnes alltid og kan ikke legges til eller fjernes.',
  environmentTooMany: 'En tjeneste kan ha høyst {max} miljøer.',
  environmentSame: 'Et miljø kan ikke fremmes til seg selv.',
  environmentNoVersion: 'Tjenesten har ingen publisert versjon {version}.',
  environmentNoEarlier: 'Miljøet {environment} har ingen tidligere versjon å rulle tilbake til.',
  environmentProdBehind:
    'prod kjører versjon {version}, ikke den nyeste. Fremme eller rull tilbake prod til den nyeste versjonen før du fjerner det siste miljøet.',
  environmentNotPublished: 'Tjenesten er ikke publisert.',
  environmentOnlyProd:
    'Tjenesten har bare prod. Publiser en tidligere versjon på nytt i stedet for å fremme eller rulle tilbake.',
  environmentPinNotAllowed:
    'Versjon {version} kjører ikke i noe miljø denne nøkkelen eller frontenden kan bruke.',
});
