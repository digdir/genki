import { defineNamespace } from '@genai/i18n';

export const blockReviews = defineNamespace({
  title: 'Designelementer til gjennomgang',
  loading: 'Henter designelementer',
  tableLabel: 'Designelementer til gjennomgang',
  empty: 'Ingen designelementer venter på gjennomgang.',
  colOrganisation: 'Virksomhet',
  colBlock: 'Designelement',
  colVersion: 'Utgave',
  colSent: 'Sendt',
  open: 'Gjennomgå',
  openFor: 'Gjennomgå {name}',
  detailTitle: '{name}, utgave {version}',
  requestReason: 'Begrunnelse fra {who}: {reason}',
  reads: 'Leser',
  events: 'Hendelser',
  none: 'Ingen',
  size: 'Størrelse: {bytes} byte',
  bundle: 'Pakke',
  bundleIsApproved:
    'Det er pakken som godkjennes. Kildene er bare til hjelp og er ikke knyttet til pakken.',
  source: 'Kilde: {path}',
  approve: 'Godkjenn',
  decline: 'Avvis',
  approved: '{name} er delt med alle, som utgave {version}.',
  declined: '{name} er avvist.',
  failed: 'Beslutningen ble ikke lagret.',
});
