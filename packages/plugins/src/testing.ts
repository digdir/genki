import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  skipped,
  type ContractSetup,
  type ContractSuite,
  type ContractTarget,
} from './contract.js';

export const describeContract = <T>(
  name: string,
  suite: ContractSuite<T>,
  setup: ContractSetup<T>,
) =>
  describe(`${suite.contract} contract: ${name}`, () => {
    let target: ContractTarget<T> | undefined;
    beforeAll(async () => {
      target = await setup();
    });
    afterAll(async () => target?.close?.());
    for (const item of suite.checks)
      it(item.name, async (ctx) => {
        if (!target) throw new Error('the contract target did not start');
        const controller = new AbortController();
        const outcome = await item.run(target.subject, controller.signal);
        if (outcome === skipped) ctx.skip();
      });
  });
