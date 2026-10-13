import { defineNamespace } from '@genai/i18n';

export const support = defineNamespace({
  expiredNotice: 'Tiden for støttetilgangen er ute. Økten er avsluttet.',
  endedNotice: 'Økten er avsluttet.',
  endedEarlyReason: 'Avsluttet av operatøren før tiden',
  reasonTooShort: 'Skriv en begrunnelse på minst {min} tegn. Nå er det {count}.',
  saveFailed: 'Kunne ikke lagre. Prøv igjen om litt.',
});
