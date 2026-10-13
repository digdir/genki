import type { ChatMessage, InputField, TableReview, UserMessage } from './types';

type Filled = NonNullable<UserMessage['values']>;

export const labelledInput = (
  fields: InputField[],
  input: Record<string, unknown> | undefined,
): Filled =>
  input
    ? fields.flatMap((f) => {
        const value = input[f.id];
        if (value === undefined || value === null || value === '') return [];
        return [{ label: f.label, value: Array.isArray(value) ? value.join(', ') : String(value) }];
      })
    : [];

const noteOf = (text: string, values: Filled) => {
  const rendered = values.map((v) => `${v.label}: ${v.value}`).join('\n');
  return text.startsWith(rendered) ? text.slice(rendered.length).trim() : text;
};

export const runTitle = (values: Filled) => {
  const title = values.map((v) => v.value).join(', ');
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
};

export const restoreRuns = async (
  messages: ChatMessage[],
  fields: InputField[],
  review: (task: string) => Promise<TableReview>,
): Promise<ChatMessage[]> => {
  const out = [...messages];
  for (const [i, m] of messages.entries()) {
    if (m.role !== 'assistant' || !m.task) continue;
    let found: TableReview;
    try {
      found = await review(m.task);
    } catch {
      continue;
    }
    if (found.table)
      out[i] = { ...m, table: found.table, ...(found.csv ? { csv: found.csv } : {}) };
    const values = labelledInput(fields, found.input);
    const asked = out[i - 1];
    if (values.length && asked?.role === 'user')
      out[i - 1] = { ...asked, values, text: noteOf(asked.text, values) };
  }
  return out;
};
