import { defineNamespace } from '@genai/i18n';

export const policies = defineNamespace({
  title: 'Krav til kvalitet og sikkerhetsregler',
  introTenant:
    'Virksomhetens egne krav og regler, ved siden av de plattformen gjelder for alle. Påkrevde regler settes bare i plattformvisningen.',
  introPlatform:
    'Krav og regler som gjelder på tvers av virksomhetene. En påkrevd regel kan ikke slås av av virksomhetene.',
  tabGates: 'Kvalitetskrav',
  tabGuardrails: 'Sikkerhetsregler',
  chooseTenant: 'Velg en virksomhet',
  atLeast: 'minst {threshold}',
  noRegression: 'ingen tilbakegang',
  kindRegex: 'Mønster',
  kindDenylist: 'Ordliste',
  kindLlmJudge: 'KI-vurdering',
  kindMcpCheck: 'Ekstern sjekk (MCP)',
  defaultsTitle: 'Plattformstandarder',
  defaultsIntro:
    'Innstillingene alle tjenester arver. Virksomheter kan overstyre noen av dem i tjenestene sine.',
  defaultsReplaced: 'Denne siden er erstattet',
  defaultsText:
    'Plattformstandardene redigeres nå i Innstillinger, i samme rutenett som virksomhetene ser. Standarder per risikonivå vises der som én innstilling med en verdi per nivå og et gulv.',
  defaultsOpen: 'Åpne Innstillinger',
});
