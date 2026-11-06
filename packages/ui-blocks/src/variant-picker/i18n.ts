import { defineNamespace, type Translation } from '@genai/i18n';

export const nbVariantPicker = defineNamespace({
  label: 'Variant: {title}',
  default: 'Standard',
  heading: 'Velg variant',
});

export const enVariantPicker = {
  label: 'Variant: {title}',
  default: 'Default',
  heading: 'Choose a variant',
} satisfies Translation<typeof nbVariantPicker>;
