import {
  defineCatalogue,
  type Format,
  type Locale,
  type MessageKey,
  type PlainKey as PlainKeyOf,
  type Translation,
} from '@genai/i18n';
import { defineTranslations } from '@genai/i18n/react';
import { answer as enAnswer } from './en/answer';
import { api as enApi } from './en/api';
import { approvals as enApprovals } from './en/approvals';
import { chat as enChat } from './en/chat';
import { document as enDocument } from './en/document';
import { errors as enErrors } from './en/errors';
import { failures as enFailures } from './en/failures';
import { feedback as enFeedback } from './en/feedback';
import { form as enForm } from './en/form';
import { project as enProject } from './en/project';
import { projects as enProjects } from './en/projects';
import { shell as enShell } from './en/shell';
import { table as enTable } from './en/table';
import { answer } from './nb/answer';
import { api } from './nb/api';
import { approvals } from './nb/approvals';
import { chat } from './nb/chat';
import { document } from './nb/document';
import { errors } from './nb/errors';
import { failures } from './nb/failures';
import { feedback } from './nb/feedback';
import { form } from './nb/form';
import { project } from './nb/project';
import { projects } from './nb/projects';
import { shell } from './nb/shell';
import { table } from './nb/table';

export const nb = defineCatalogue({
  shell,
  chat,
  answer,
  feedback,
  failures,
  form,
  approvals,
  document,
  errors,
  table,
  projects,
  project,
  api,
});

export const en = {
  shell: enShell,
  chat: enChat,
  answer: enAnswer,
  feedback: enFeedback,
  failures: enFailures,
  form: enForm,
  approvals: enApprovals,
  document: enDocument,
  errors: enErrors,
  table: enTable,
  projects: enProjects,
  project: enProject,
  api: enApi,
} satisfies Translation<typeof nb>;

export const { useT, translator } = defineTranslations({ nb, en });
export type Key = MessageKey<typeof nb>;
export type PlainKey = PlainKeyOf<typeof nb>;
export type T = ReturnType<typeof translator>;
export type { Format, Locale };
