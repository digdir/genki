import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonValue, Side } from './types.js';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'scope.json');

export type Role = 'agent' | 'probe';

export const capabilities = (
  JSON.parse(readFileSync(file, 'utf8')) as { capabilities: Record<Role, Record<Side, string>> }
).capabilities;

export const toolName = (role: Role, side: Side) => capabilities[role][side];

export const agentId = (role: Role, side: Side) => {
  const name = toolName(role, side);
  const agent = name.slice(0, name.indexOf('__'));
  return side === 'old' ? agent.replace(/\./g, '/') : agent;
};

export const parityScope = new Set(Object.values(capabilities).map((c) => c.old));

export const newToOld = new Map(
  (Object.keys(capabilities) as Role[]).flatMap((role) => [
    [toolName(role, 'new'), toolName(role, 'old')],
    [agentId(role, 'new'), agentId(role, 'old')],
  ]),
);

export const renamed = <T extends JsonValue | string>(value: T, names: Map<string, string>): T => {
  if (typeof value === 'string') return (names.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => renamed(v, names)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renamed(v, names)])) as T;
  return value;
};

const capabilityName = (value: JsonValue): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = value.name ?? value.id;
  return typeof name === 'string' && name.includes('__') ? name : undefined;
};

export const withinScope = (
  value: JsonValue | undefined,
  scope: Set<string>,
): JsonValue | undefined => {
  if (Array.isArray(value)) {
    const named = value.length > 0 && value.every((v) => capabilityName(v) !== undefined);
    const items = named
      ? value
          .filter((v) => scope.has(capabilityName(v) as string))
          .sort((a, b) => (capabilityName(a) as string).localeCompare(capabilityName(b) as string))
      : value;
    return items.map((v) => withinScope(v, scope) ?? null);
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withinScope(v, scope) ?? null]),
    );
  return value;
};
