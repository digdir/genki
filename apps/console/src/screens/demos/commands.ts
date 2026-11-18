import { parse } from 'yaml';
import type { T } from '../../i18n';

const option = (command: readonly string[], name: string) => {
  const at = command.indexOf(name);
  return at >= 0 ? command[at + 1] : undefined;
};

const roleName = (role: string, t: T) =>
  role === 'button'
    ? t('demos.roleButton')
    : role === 'link'
      ? t('demos.roleLink')
      : role === 'tab'
        ? t('demos.roleTab')
        : role === 'textbox'
          ? t('demos.roleTextbox')
          : t('demos.roleOther', { role });

export const describeCommand = (command: readonly string[], t: T) => {
  const [name, kind, value] = command;
  if (name === 'find' && kind === 'role' && value)
    return t('demos.commandFind', {
      role: roleName(value, t),
      name: option(command, '--name') ?? '',
    });
  if (name === 'find' && kind === 'text' && value)
    return t('demos.commandFindText', { name: value });
  if (name === 'wait' && option(command, '--text'))
    return t('demos.commandWait', { text: option(command, '--text') ?? '' });
  if (name === 'fill' && kind) return t('demos.commandFill', { target: kind, text: value ?? '' });
  if (name === 'open' && kind) return t('demos.commandOpen', { url: kind });
  return t('demos.commandOther', { command: command.join(' ') });
};

const plain = /^[\p{L}\p{N}_./-][\p{L}\p{N}_./#:?=&@ -]*$/u;

const quoted = (part: string) =>
  plain.test(part) &&
  !/^\d+$/.test(part) &&
  !part.includes(': ') &&
  !part.includes(' #') &&
  !part.endsWith(':') &&
  part.trim() === part
    ? part
    : JSON.stringify(part);

export const commandLine = (command: readonly string[]) => `[${command.map(quoted).join(', ')}]`;

export const commandsText = (commands: readonly (readonly string[])[] | undefined) =>
  (commands ?? []).map(commandLine).join('\n');

export const parseCommands = (
  text: string,
): { ok: true; commands: string[][] } | { ok: false; line: number } => {
  const commands: string[][] = [];
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = parse(line);
    } catch {
      return { ok: false, line: i + 1 };
    }
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((p) => typeof p === 'string' || typeof p === 'number')
    )
      return { ok: false, line: i + 1 };
    commands.push(value.map(String));
  }
  return { ok: true, commands };
};
