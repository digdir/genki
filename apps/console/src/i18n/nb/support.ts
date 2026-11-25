import { defineNamespace } from '@genai/i18n';

export const support = defineNamespace({
  reasonTooShort: 'Skriv en begrunnelse på minst {min} tegn. Nå er det {count}.',
  saveFailed: 'Kunne ikke lagre. Prøv igjen om litt.',
  contentReasonTitle: 'Grunn for å se innhold',
  contentReasonLead:
    'Innholdet til {tenant} kan inneholde personopplysninger. Skriv hvorfor du trenger å se det.',
  contentReasonHint: 'Minst 10 tegn.',
  contentReasonSees:
    'Grunnen gjelder for deg og denne virksomheten resten av dagen og vises i virksomhetens logg.',
  contentReasonCta: 'Se innhold',
});
