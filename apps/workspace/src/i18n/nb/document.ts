import { defineNamespace } from '@genai/i18n';

export const document = defineNamespace({
  intro:
    'Slik merkes et dokument som en tjeneste har laget. Merket står øverst og nederst, også i Word-filen.',
  aiDraft: 'Utkast laget med KI',
  bannerText:
    'Kontroller innholdet før det sendes. Merket fjernes først når en saksbehandler har godkjent utkastet.',
  meta: '{agency} · Saksnummer {caseNumber} · {date}',
  fallbackHeading: 'Dokumentutkast',
  noProvenance:
    'Vi fant ikke opplysninger om hvordan utkastet ble laget. Kontroller det ekstra nøye.',
  download: 'Last ned som Word',
  goToApprovals: 'Gå til godkjenning',
  footerApproved: 'Laget med KI av tjenesten {service} og godkjent av saksbehandler',
  footerDraft: 'Utkast laget med KI av tjenesten {service}',
  footerVersion: 'versjon {version}',
  footerAt: '{when}.',
  footerBasis: ' Grunnlag: {sources}.',
});
