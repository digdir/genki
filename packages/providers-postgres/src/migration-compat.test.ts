import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(join(import.meta.dirname, 'schema.ts'), 'utf8');
const statements = schema
  .split(/[`;]/)
  .map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
  .filter(Boolean);

describe('schema migrations, run by a new API revision while the old one still serves', () => {
  it('never drop or rename a table or column, nor change a column type', () => {
    const breaking = statements.filter((s) =>
      /\bdrop table\b|\bdrop column\b|\brename (column|to)\b|\balter column \S+ (set data )?type\b|\balter column \S+ set not null\b/.test(
        s,
      ),
    );
    expect(breaking).toEqual([]);
  });

  it('add a column only as nullable or with a default, so old inserts keep working', () => {
    const added = statements.flatMap((s) =>
      s.split(/(?=\badd column\b)/).filter((part) => part.startsWith('add column')),
    );
    expect(added.length).toBeGreaterThan(0);
    const unsafe = added.filter((c) => /\bnot null\b/.test(c) && !/\bdefault\b/.test(c));
    expect(unsafe).toEqual([]);
  });
});
