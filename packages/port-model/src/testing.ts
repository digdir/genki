import type { Ref, Usage } from '@genai/contracts';
import type { PortContext } from '@genai/kernel';

export { fakeHttp, type FakeReply, type FakeServer, type SeenRequest } from '@genai/plugins';

export interface TestContext {
  ctx: PortContext;
  metered: { usage: Usage; model?: Ref }[];
}

export const testContext = (signal: AbortSignal = new AbortController().signal): TestContext => {
  const metered: TestContext['metered'] = [];
  const ctx: PortContext = {
    tenant: '999888777',
    principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '999888777' },
    task: 't1',
    signal,
    meter: async (usage, model) => {
      metered.push({ usage, ...(model ? { model } : {}) });
    },
  };
  return { ctx, metered };
};
