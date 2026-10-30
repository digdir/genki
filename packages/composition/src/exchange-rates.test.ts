import type { Clock } from '@genai/jobs';
import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import { latestUsdNok, norgesBankUsdNok, scheduleUsdNok } from './exchange-rates.js';

/** Norges Bank's answer for one day, as data.norges-bank.no gave it on 2026-10-30. */
const answer = (rate: string, day: string) =>
  JSON.stringify({
    data: {
      dataSets: [{ series: { '0:0:0:0': { observations: { '0': [rate] } } } }],
      structure: {
        dimensions: { observation: [{ id: 'TIME_PERIOD', values: [{ id: day }] }] },
      },
    },
  });

describe('the USD/NOK rate', () => {
  it("reads Norges Bank's USD/NOK rate once a day through the egress guard, and shows dollars until one is known", async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const asked: { allow: unknown; url: string }[] = [];
    const days = [answer('9.2826', '2026-10-29'), answer('9.3110', '2026-10-30')];
    const guard = {
      request: async (allow: { host: string; port?: number }[], url: string) => {
        asked.push({ allow, url });
        return { status: 200, headers: {}, body: days.shift() ?? '' };
      },
    };
    const timers: (() => void)[] = [];
    const clock: Clock = {
      now: () => new Date('2026-10-30T15:00:00Z'),
      setTimer: (_at, run) => {
        timers.push(run);
        return () => undefined;
      },
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    const before = await latestUsdNok(configEntries);

    const job = scheduleUsdNok({ configEntries, guard, clock });
    timers.shift()?.();
    await settle();
    const first = await latestUsdNok(configEntries);
    timers.shift()?.();
    await settle();
    job.stop();

    expect(before).toBeUndefined();
    expect(first).toEqual({ rate: 9.2826, date: '2026-10-29' });
    expect(await latestUsdNok(configEntries)).toEqual({ rate: 9.311, date: '2026-10-30' });
    expect(asked).toEqual([
      { allow: [{ host: 'data.norges-bank.no', port: 443 }], url: norgesBankUsdNok },
      { allow: [{ host: 'data.norges-bank.no', port: 443 }], url: norgesBankUsdNok },
    ]);
  });
});
