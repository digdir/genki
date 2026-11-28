import { defineNamespace } from '@genai/i18n';

export const contentView = defineNamespace({
  title: 'Se innhold fra {tenant}',
  lead: 'Kan inneholde personopplysninger. Gjelder resten av dagen.',
  hint: 'Virksomheten ser den i loggen.',
  cta: 'Se innholdet',
  failed: 'Kunne ikke lagre begrunnelsen. Prøv igjen om litt.',
});
