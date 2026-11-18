import { inputForm } from './setup-input';
import { languageTabs } from './setup-languages';
import { setup, setupList } from './setup-tab';
import { tableOutput } from './setup-table';

export const setupUi = { inputForm, languageTabs, setup, setupList, tableOutput } as const;
