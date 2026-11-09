import { defineCatalogue, defineNamespace, type Translation } from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';

// `{panel}` is the panel's own name, lower-cased: «Skjul tråder og filter».
export const nbShell = defineNamespace({
  skipToMain: 'Hopp til hovedinnhold',
  // The word beside the icon on an open primary panel; the button's name starts with it, so a
  // voice user can say what they see (WCAG 2.5.3).
  hide: 'Skjul',
  hidePanel: 'Skjul {panel}',
  showPanel: 'Vis {panel}',
  closePanel: 'Lukk {panel}',
  resizePanel: 'Endre bredde på {panel}',
  // The separator's value while a drag has folded the panel.
  hidden: 'Skjult',
  // Without a unit, `aria-valuenow` is read as a bare number.
  width: '{width} piksler',
});

export const enShell = {
  skipToMain: 'Skip to main content',
  hide: 'Hide',
  hidePanel: 'Hide {panel}',
  showPanel: 'Show {panel}',
  closePanel: 'Close {panel}',
  resizePanel: 'Resize {panel}',
  hidden: 'Hidden',
  width: '{width} pixels',
} satisfies Translation<typeof nbShell>;

/**
 * The shell's own catalogue. It stays out of the package's shared one, so a host that imports
 * another block, such as Approach, does not load these words. A block that borrows them puts this
 * namespace in its own catalogue.
 */
export const nb = defineCatalogue({ shell: nbShell });
export const en = { shell: enShell } satisfies Translation<typeof nb>;

export const { useT, translator } = defineTranslations({ nb, en });
