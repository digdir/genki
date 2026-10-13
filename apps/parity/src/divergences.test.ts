import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { divergenceFor, divergences, meetsExpectation, parseDivergences } from './divergences.js';

const adr = readFileSync(
  join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'docs',
    'adr',
    '0017-parity-scope-and-intentional-divergences.md',
  ),
  'utf8',
);

describe('ADR 0017 divergences', () => {
  it('lists every row of the ADR table the harness checks, word for word', () => {
    const section =
      adr.split('## Divergences the parity harness checks')[1]?.split('\n## ')[0] ?? '';
    const rows = section
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Behaviour') && !l.startsWith('| ---'))
      .map((l) => l.split('|')[1]?.trim().replace(/`/g, ''));

    expect(divergences.map((d) => d.behaviour)).toEqual(rows);
    expect(divergences.every((d) => d.adr === '0017')).toBe(true);
  });

  it('every other divergence row is marked Different, Dropped or Missing, never Covered', () => {
    const other = adr.split('## Other divergences')[1]?.split('\n## ')[0] ?? '';
    const statuses = other
      .split('\n')
      .filter(
        (l) => l.startsWith('| ') && !l.startsWith('| headless-rag') && !l.startsWith('| ---'),
      )
      .map((l) => l.split('|')[3]?.trim());

    expect(statuses.length).toBeGreaterThan(30);
    expect(statuses.filter((s) => !['Different', 'Dropped', 'Missing'].includes(s ?? ''))).toEqual(
      [],
    );
  });

  it('matches scenarios by exact id or by a prefix ending in a dot', () => {
    expect(divergenceFor('mcp.ping')?.id).toBe('mcp-ping');
    expect(divergenceFor('mcp.ping-twice')).toBeUndefined();
    expect(divergenceFor('debug.retrieval')?.action).toBe('invert');
    expect(divergenceFor('v1.models')).toBeUndefined();
  });

  it('checks the status and body the ADR expects of the new platform', () => {
    const ping = divergenceFor('mcp.ping')?.expect;
    expect(
      meetsExpectation({ status: 404, headers: {}, body: { error: { code: -32601 } } }, ping),
    ).toEqual([]);
    expect(meetsExpectation({ status: 200, headers: {}, body: { result: {} } }, ping)).toHaveLength(
      2,
    );
  });

  it('refuses a malformed list', () => {
    const adrPath = 'docs/adr/0017-parity-scope-and-intentional-divergences.md';
    expect(() =>
      parseDivergences({
        adr: adrPath,
        divergences: [{ id: 'x', behaviour: 'b', reason: 'r', scenarios: ['s'], action: 'ignore' }],
      }),
    ).toThrow(/skip or invert/);
    expect(() =>
      parseDivergences({
        adr: adrPath,
        divergences: [{ id: 'x', behaviour: 'b', reason: 'r', scenarios: [], action: 'skip' }],
      }),
    ).toThrow(/non-empty/);
    expect(() => parseDivergences({ adr: 'nowhere', divergences: [] })).toThrow(/ADR file/);
  });
});
