import type { Definition } from './schema.js';
import type { ValidationError } from './validate.js';

export type PromptFiles = Record<string, string>;

export const promptPath = /^prompts\/[a-z0-9][a-z0-9._/-]*\.md$/;

const maxPromptBytes = 64 * 1024;

const walk = (value: unknown, path: string, visit: (text: string, path: string) => void) => {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, visit);
};

export const promptReferences = (definition: Definition) => {
  const refs: { path: string; file: string }[] = [];
  walk(definition.spec, 'spec', (text, path) => {
    if (promptPath.test(text)) refs.push({ path, file: text });
  });
  return refs;
};

export const checkPromptFiles = (definition: Definition, files: PromptFiles): ValidationError[] => {
  const errors: ValidationError[] = [];
  const referenced = new Set<string>();
  for (const { path, file } of promptReferences(definition)) {
    referenced.add(file);
    if (!(file in files)) errors.push({ path, message: `missing prompt file ${file}` });
  }
  for (const [name, content] of Object.entries(files)) {
    if (!promptPath.test(name) || name.includes('..'))
      errors.push({ path: `files.${name}`, message: 'a prompt file must be prompts/<name>.md' });
    else if (!referenced.has(name))
      errors.push({ path: `files.${name}`, message: 'the definition does not use this file' });
    else if (typeof content !== 'string' || content.trim().length === 0)
      errors.push({ path: `files.${name}`, message: 'a prompt file cannot be empty' });
    else if (new TextEncoder().encode(content).length > maxPromptBytes)
      errors.push({ path: `files.${name}`, message: 'a prompt file is at most 64 KB' });
  }
  return errors;
};

export const resolvePrompts = <T>(value: T, files: PromptFiles): T => {
  if (typeof value === 'string')
    return (promptPath.test(value) && value in files ? files[value] : value) as T;
  if (Array.isArray(value)) return value.map((v) => resolvePrompts(v, files)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolvePrompts(v, files)]),
    ) as T;
  return value;
};
