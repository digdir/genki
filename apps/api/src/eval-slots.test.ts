import { describe, expect, it } from 'vitest';
import { defaultEvalSlotLimits, evalSlotLimitsFromEnv, evalSlots } from './eval-slots.js';

describe('case slots for test-set runs', () => {
  it('reads the limits from the environment and leaves out missing or invalid values', () => {
    expect(
      evalSlotLimitsFromEnv({
        EVAL_CASES_PER_INSTANCE: '12',
        EVAL_CASES_PER_TENANT: '0',
        EVAL_CASES_PER_RUN: 'tre',
      }),
    ).toEqual({ perInstance: 12 });
    expect(evalSlots().limits).toEqual(defaultEvalSlotLimits);
  });

  it('never lets a tenant or a run hold more than the instance allows', () => {
    expect(evalSlots({ perInstance: 2, perTenant: 6, perRun: 9 }).limits).toEqual({
      perInstance: 2,
      perTenant: 2,
      perRun: 2,
    });
  });

  it('gives waiting runs a slot in turn, a run that has not had one first', async () => {
    const slots = evalSlots({ perInstance: 1, perTenant: 1, perRun: 1 });
    const served: string[] = [];
    const take = (run: ReturnType<typeof slots.session>, name: string) =>
      run.acquire().then((release) => {
        served.push(name);
        return release;
      });
    const a = slots.session('a', 'x');
    const b = slots.session('b', 'y');
    const c = slots.session('c', 'z');

    const first = await take(a, 'a');
    const again = take(a, 'a');
    const second = take(b, 'b');
    const third = take(c, 'c');
    first();
    (await second)();
    (await third)();
    (await again)();

    expect(served).toEqual(['a', 'b', 'c', 'a']);
    expect(slots.inFlight()).toBe(0);
  });
});
