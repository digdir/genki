import type { Translation } from '@genai/i18n';
import type { setupUi as source } from '../nb/build-setupUi';
import { inputForm } from './setup-input';
import { languageTabs } from './setup-languages';
import { setup, setupList } from './setup-tab';
import { tableOutput } from './setup-table';

export const setupUi = {
  inputForm,
  languageTabs,
  setup,
  setupList,
  tableOutput,
} satisfies Translation<typeof source>;
