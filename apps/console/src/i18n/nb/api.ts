import { defineNamespace } from '@genai/i18n';

export const api = defineNamespace({
  unknownUser: 'Ukjent bruker',
  loginFailed: 'Innloggingen mislyktes.',
  loginUnavailable: 'Innlogging er ikke tilgjengelig her.',
  reminderReason: 'Påminnelse om oppstart',
  exportReason: 'Eksport av revisjonsloggen',
  tracingReason: 'Endret sporing',
});
