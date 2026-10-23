import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { drift, enumOf, flowPath, jurisdictionsOf, withEnum } from './ai-policy-jurisdictions.ts';

const flow = readFileSync(flowPath, 'utf8');

const extractPrompt = () =>
  (parseYaml(flow) as { spec: { steps: { input: { prompt: string } }[] } }).spec.steps[0]?.input
    .prompt ?? '';

describe('the AI policy comparison flow jurisdiction enum', () => {
  it('rewriting the committed flow with its own enum changes nothing, so a regeneration diff shows only real changes', () => {
    expect(withEnum(flow, enumOf(flow))).toBe(flow);
  });

  it('adds a new jurisdiction from the records in sorted order and reports it as drift', () => {
    const current = enumOf(flow);
    const wanted = jurisdictionsOf([
      ...current.map((jurisdiction) => ({ jurisdiction })),
      { jurisdiction: 'Faroe Islands' },
      { jurisdiction: ' Norway ' },
      { jurisdiction: '' },
      {},
    ]);

    const rewritten = enumOf(withEnum(flow, wanted));

    expect(drift(current, wanted)).toEqual({ added: ['Faroe Islands'], removed: [] });
    expect(rewritten).toEqual([...current, 'Faroe Islands'].sort());
    expect(drift(rewritten, wanted)).toEqual({ added: [], removed: [] });
  });

  it('is sorted and has no duplicates, as the regeneration writes it', () => {
    const names = enumOf(flow);

    expect(names.length).toBeGreaterThan(100);
    expect(names).toEqual(jurisdictionsOf(names.map((jurisdiction) => ({ jurisdiction }))));
  });

  it('holds every English name the extract prompt maps a bokmål name to', () => {
    const mapping = extractPrompt().split('\n\n')[0] ?? '';
    const named = [...mapping.matchAll(/"([^"]*)"/g)]
      .map((m) => m[1] ?? '')
      .filter((n) => !n.startsWith('('));

    expect(named).toEqual(expect.arrayContaining(['Norway', 'European Union', 'California (US)']));
    expect(named.filter((n) => !enumOf(flow).includes(n as string))).toEqual([]);
  });
});
