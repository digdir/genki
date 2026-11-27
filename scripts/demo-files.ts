// Writes and reads the files of one recording run, each by a plain name inside the run's folder.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const runFileName = /^[\w-][\w.-]{0,79}$/;
export const maxRunJsonBytes = 2 * 1024 * 1024;

export const writeRunFile = (
  dir: string,
  name: string,
  data: string | Uint8Array,
  maxBytes: number,
) => {
  if (!runFileName.test(name)) throw new Error(`${name} is not a file name in the run folder`);
  const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  if (size > maxBytes)
    throw new Error(`${name} is ${size} bytes, more than the ${maxBytes} allowed`);
  writeFileSync(join(dir, name), data);
};

export const writeRunJson = (dir: string, name: string, value: unknown) =>
  writeRunFile(dir, name, JSON.stringify(value, null, 2), maxRunJsonBytes);

export const readJsonIfThere = (file: string): unknown => {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text);
};
