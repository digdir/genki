import { defineNamespace } from '@genai/i18n';

export const api = defineNamespace({
  unknownUser: 'Ukjent bruker',
  loginCancelled: 'Innloggingen ble avbrutt.',
  loginIncomplete: 'Innloggingen kunne ikke fullføres. Prøv igjen.',
  loginWrongIssuer: 'Innloggingen kom fra feil utsteder.',
  loginFailed: 'Innloggingen mislyktes.',
  accessCheckFailed: 'Kunne ikke sjekke tilgangen din. Prøv igjen om litt.',
  reminderReason: 'Påminnelse om oppstart',
  exportReason: 'Eksport av revisjonsloggen',
  tracingReason: 'Endret sporing',
});
