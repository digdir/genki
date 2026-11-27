import { defineNamespace } from '@genai/i18n';

export const tracing = defineNamespace({
  title: 'Sporing og evaluering for plattformen',
  intro: 'Hvor plattformen sender spor for alle virksomheter.',
  sourceNote:
    'Plattformens egen logg er alltid kilden. Eksterne verktøy får en kopi, og kan kobles til og fra uten at tjenestene endres.',
  fixedRule: 'Fast regel, kan ikke endres:',
  fixedRuleText:
    ' navn på ansatte sendes aldri til eksterne verktøy. Personen vises som «Ansatt i virksomheten» med et fast pseudonym per tjeneste.',
  loading: 'Henter sporingsstatus',
  envTitle: 'Plattformens sporing',
  on: 'På',
  off: 'Av',
  envNote: 'Styres av API-ets innstillinger ved oppstart.',
  target: 'Mål',
  content: 'Innhold',
  fullContent: 'Fullt innhold',
  metaOnly: 'Bare metadata',
  shareSent: 'Andel som sendes',
  sent: 'Sendt',
  failed: 'Feilet',
  percent: '{value} %',
  unavailableTitle: 'Ikke tilgjengelig ennå',
  unavailableText:
    'Å koble til og konfigurere sporingsverktøy fra konsollet er ikke tilgjengelig ennå.',
});
