import { defineNamespace } from '@genai/i18n';

export const feedback = defineNamespace({
  label: 'Tilbakemelding på svaret',
  useful: 'Var svaret nyttig?',
  yes: 'Ja',
  no: 'Nei',
  whatWrong: 'Hva var galt? (valgfritt)',
  reasonWrong: 'Feil',
  reasonNoSource: 'Mangler kilde',
  reasonOutdated: 'Utdatert',
  reasonHard: 'Vanskelig å forstå',
  comment: 'Kommentar (valgfritt)',
  counter: '{length} av {max} tegn. Ikke skriv personopplysninger.',
  send: 'Send',
  skip: 'Hopp over',
  thanksDetails: 'Takk! Tilbakemeldingen lagres for tjenesten, ikke for deg som person.',
  thanks: 'Takk!',
  notSent: 'Tilbakemeldingen ble ikke sendt. Prøv igjen om litt.',
});
