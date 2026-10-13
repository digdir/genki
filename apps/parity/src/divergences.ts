import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Captured, JsonValue } from './types.js';

export interface Expectation {
  status?: number[];
  body?: Record<string, JsonValue>;
}

export interface Divergence {
  id: string;
  adr: string;
  behaviour: string;
  reason: string;
  scenarios: string[];
  action: 'skip' | 'invert';
  expect?: Expectation;
}

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'divergences.json');

const fail = (message: string): never => {
  throw new Error(`${file}: ${message}`);
};

const strings = (value: unknown, path: string): string[] =>
  Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')
    ? value
    : fail(`${path} must be a non-empty list of strings`);

const expectation = (value: unknown, path: string): Expectation | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail(`${path} must be an object`);
  const { status, body, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0)
    fail(`${path} has unknown keys ${Object.keys(rest).join(', ')}`);
  if (status !== undefined && !(Array.isArray(status) && status.every(Number.isInteger)))
    fail(`${path}.status must be a list of status codes`);
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body)))
    fail(`${path}.body must map JSON paths to values`);
  return {
    ...(status ? { status: status as number[] } : {}),
    ...(body ? { body: body as Record<string, JsonValue> } : {}),
  };
};

export const parseDivergences = (input: unknown): Divergence[] => {
  if (!input || typeof input !== 'object') return fail('must be an object');
  const { adr, divergences } = input as { adr?: unknown; divergences?: unknown };
  const adrNumber = typeof adr === 'string' ? /(\d{4})-/.exec(adr)?.[1] : undefined;
  if (!adrNumber) return fail('adr must point at the ADR file');
  if (!Array.isArray(divergences)) return fail('divergences must be a list');
  return divergences.map((d: Record<string, unknown>, i) => {
    const path = `divergences[${i}]`;
    if (d.action !== 'skip' && d.action !== 'invert') fail(`${path}.action must be skip or invert`);
    for (const key of ['id', 'behaviour', 'reason'])
      if (typeof d[key] !== 'string' || d[key] === '') fail(`${path}.${key} is required`);
    const expect = expectation(d.expect, `${path}.expect`);
    return {
      id: d.id as string,
      adr: adrNumber,
      behaviour: d.behaviour as string,
      reason: d.reason as string,
      scenarios: strings(d.scenarios, `${path}.scenarios`),
      action: d.action as Divergence['action'],
      ...(expect ? { expect } : {}),
    };
  });
};

export const divergences: Divergence[] = parseDivergences(JSON.parse(readFileSync(file, 'utf8')));

export const divergenceFor = (scenario: string, list: Divergence[] = divergences) =>
  list.find((d) =>
    d.scenarios.some((s) => (s.endsWith('.') ? scenario.startsWith(s) : scenario === s)),
  );

const at = (value: JsonValue | string | undefined, path: string): JsonValue | undefined => {
  let current: JsonValue | string | undefined = value;
  for (const key of path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' || current === undefined ? current : current;
};

export const meetsExpectation = (captured: Captured, expect: Expectation | undefined): string[] => {
  if (!expect) return [];
  const problems: string[] = [];
  if (expect.status && !expect.status.includes(captured.status))
    problems.push(`status ${captured.status}, expected one of ${expect.status.join(', ')}`);
  for (const [path, wanted] of Object.entries(expect.body ?? {})) {
    const actual = at(captured.body, path);
    if (JSON.stringify(actual) !== JSON.stringify(wanted))
      problems.push(`${path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
  }
  return problems;
};
