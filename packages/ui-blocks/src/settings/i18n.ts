import { defineNamespace, type Translation } from '@genai/i18n';

export const nbSettings = defineNamespace({
  title: 'Innstillinger',
  colorScheme: 'Fargemodus',
  light: 'Lys',
  dark: 'Mørk',
  // «Auto», not «Automatisk»: three items share the width, and the longest word decides how narrow
  // the other two get.
  auto: 'Auto',
});

export const enSettings = {
  title: 'Settings',
  colorScheme: 'Colour scheme',
  light: 'Light',
  dark: 'Dark',
  auto: 'Auto',
} satisfies Translation<typeof nbSettings>;
