import { describe, expect, it } from 'vitest';
import { timeGrowth } from '../test/linear-time.ts';
import { outcomesOf, summary, tally } from './flaky-summary.ts';

const junit = (cases: string) => `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests">
    <testsuite name="a.test.ts">
${cases}
    </testsuite>
</testsuites>`;

const passed = `<testcase classname="a.test.ts" name="a suite &gt; keeps &quot;a&quot; rule" time="0.1">
        </testcase>`;
const failed = `<testcase classname="a.test.ts" name="a suite &gt; keeps &quot;a&quot; rule" time="0.1">
            <failure message="expected 1 to be 2" type="AssertionError">at a.test.ts:3</failure>
        </testcase>`;
const skipped = `<testcase classname="a.test.ts" name="another rule" time="0"><skipped/></testcase>`;
const steady = `<testcase classname="a.test.ts" name="a steady rule" time="0"/>`;

describe('the flaky test summary', () => {
  it('reads each test case as passed, failed or skipped under its file and full name', () => {
    expect([...outcomesOf(junit([failed, skipped, steady].join('\n')))]).toEqual([
      ['a.test.ts > a suite > keeps "a" rule', 'failed'],
      ['a.test.ts > another rule', 'skipped'],
      ['a.test.ts > a steady rule', 'passed'],
    ]);
  });

  it('names a test that passed and failed across runs as flaky', () => {
    const runs = [junit(`${passed}\n${steady}`), junit(`${failed}\n${steady}`), junit(passed)];
    const text = summary(tally(runs.map(outcomesOf)), runs.length);

    expect(text).toContain('3 JUnit files, 2 tests: 1 passed every time, 1 flaky, 0 failed');
    expect(text).toContain('| a.test.ts > a suite > keeps "a" rule | 2 | 1 | 0 |');
    expect(text).not.toContain('| a.test.ts > a steady rule');
  });

  it('lists a test that failed in every run apart from the flaky ones', () => {
    const text = summary(tally([outcomesOf(junit(failed)), outcomesOf(junit(failed))]), 2);

    expect(text).toContain('0 flaky, 1 failed every time');
    expect(text).toMatch(/### Flaky: passed and failed\n\nNone\./);
    expect(text).toContain('| a.test.ts > a suite > keeps "a" rule | 0 | 2 | 0 |');
  });

  it('keeps a pipe in a test name from breaking the table', () => {
    const piped = `<testcase classname="a.test.ts" name="a | b"><failure/></testcase>`;
    expect(summary(tally([outcomesOf(junit(piped))]), 1)).toContain('| a.test.ts > a \\| b | 0 |');
  });

  it('reads a long run of unclosed test cases and attribute names in linear time', () => {
    const growth = timeGrowth(
      (n) => outcomesOf(`${'<testcase '.repeat(n)}${'a'.repeat(10 * n)}`),
      5_000,
    );
    expect(growth).toBeLessThan(32);
  });
});
