import { checkEqual, failure, type ContractSuite } from '@genai/plugins';
import { memoryUsageSource, type FakeCall } from './memory.js';
import {
  rfc3339,
  UsageGatewayError,
  usageGroupBy,
  type GatewayUsageGroup,
  type GatewayUsageRequest,
  type UsageGateway,
} from './usage.js';

export const usageContractVersion = 'usage@2';

/** What a check arranges calls in; for genki's own targets, the fake behind them. */
export interface UsageArrange {
  record(call: FakeCall): void;
}

export interface UsageContractSubject {
  gateway: UsageGateway;
  arrange: UsageArrange;
}

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

let runs = 0;
const next = () => (runs += 1);
const org = (n: number) => String(900_000_000 + n * 1000 + (runs % 1000));

const dayOf = (n: number) => Date.parse('2026-01-01T00:00:00Z') + n * 2 * dayMs;

const at = (ms: number) => rfc3339(new Date(ms));

const request = (day: number, hours: number, extra: Partial<GatewayUsageRequest> = {}) => ({
  timeRange: {
    from: at(day),
    to: at(day + hours * hourMs),
  },
  bucketSeconds: 3600,
  groupBy: usageGroupBy,
  ...extra,
});

const call = (n: number, at: number, extra: Partial<FakeCall> = {}): FakeCall => ({
  client: `client-${n}`,
  org: org(1),
  model: 'gpt-test',
  at: new Date(at),
  inputTokens: 100,
  outputTokens: 10,
  costMicros: 1000,
  ...extra,
});

const figures = (g: GatewayUsageGroup) => [
  g.group.requestModel,
  g.group['usage.org'],
  g.inputTokens,
  g.outputTokens,
  g.totalTokens,
  g.requests,
  g.cost,
];

const statusOf = async (run: () => Promise<unknown>) => {
  const error = await failure(run);
  return error instanceof UsageGatewayError ? error.status : undefined;
};

export const usageContract: ContractSuite<UsageContractSubject> = {
  contract: usageContractVersion,
  checks: [
    {
      name: 'answers a sum per group for the range and one flat entry per bucket and group, with tokens, requests and cost in dollars',
      run: async (s) => {
        const n = next();
        const day = dayOf(n);
        s.arrange.record(call(n, day + 60_000));
        s.arrange.record(call(n, day + hourMs + 60_000, { outputTokens: 30, costMicros: 3000 }));
        s.arrange.record(call(n, day + 120_000, { model: 'other-model' }));
        const answer = await s.gateway.query(
          request(day, 2, { filters: { attributes: { 'usage.org': org(1) } } }),
        );
        checkEqual(
          answer.groups.map(figures),
          [
            ['gpt-test', org(1), 200, 40, 240, 2, 0.004],
            ['other-model', org(1), 100, 10, 110, 1, 0.001],
          ],
          'groups',
        );
        checkEqual(
          answer.buckets.map((b) => [Date.parse(b.start), ...figures(b)]),
          [
            [day, 'gpt-test', org(1), 100, 10, 110, 1, 0.001],
            [day, 'other-model', org(1), 100, 10, 110, 1, 0.001],
            [day + hourMs, 'gpt-test', org(1), 100, 30, 130, 1, 0.003],
          ],
          'buckets',
        );
      },
    },
    {
      name: 'leaves out a bucket without calls and puts a call in the bucket it started in',
      run: async (s) => {
        const n = next();
        const day = dayOf(n);
        s.arrange.record(call(n, day + 59 * 60_000 + 59_000));
        s.arrange.record(call(n, day + 2 * hourMs + 60_000));
        const answer = await s.gateway.query(
          request(day, 3, { filters: { attributes: { 'usage.org': org(1) } } }),
        );
        checkEqual(
          answer.buckets.map((b) => Date.parse(b.start)),
          [day, day + 2 * hourMs],
          'buckets',
        );
      },
    },
    {
      name: "holds only the filtered organisation's calls",
      run: async (s) => {
        const n = next();
        const day = dayOf(n);
        s.arrange.record(call(n, day + 60_000));
        s.arrange.record(call(n, day + 60_000, { org: org(2) }));
        const answer = await s.gateway.query(
          request(day, 1, { filters: { attributes: { 'usage.org': org(2) } } }),
        );
        checkEqual(
          answer.groups.map((g) => g.group['usage.org']),
          [org(2)],
          'organisations',
        );
      },
    },
    {
      name: 'records a genki call on the organisation in genki-tenant, with genki as the client',
      run: async (s) => {
        const n = next();
        const day = dayOf(n);
        s.arrange.record(call(n, day + 60_000, { client: `genki-${n}`, org: org(3) }));
        const [group] = (
          await s.gateway.query(
            request(day, 1, { filters: { attributes: { 'usage.org': org(3) } } }),
          )
        ).groups;
        checkEqual(
          group?.group,
          { requestModel: 'gpt-test', 'usage.org': org(3), 'usage.client': `genki-${n}` },
          'group',
        );
      },
    },
    {
      name: 'answers null for a grouped attribute the call lacked',
      run: async (s) => {
        const n = next();
        const day = dayOf(n);
        const lacking = call(n, day + 60_000);
        delete lacking.org;
        s.arrange.record(lacking);
        const [group] = (await s.gateway.query(request(day, 1))).groups;
        checkEqual(
          group?.group,
          { requestModel: 'gpt-test', 'usage.org': null, 'usage.client': `client-${n}` },
          'group',
        );
      },
    },
    {
      name: 'counts only calls with the filtered status',
      run: async (s) => {
        const n = next();
        const day = dayOf(n);
        s.arrange.record(call(n, day + 60_000, { org: org(4) }));
        s.arrange.record(call(n, day + 60_000, { org: org(4), httpStatus: 429 }));
        const [group] = (
          await s.gateway.query(
            request(day, 1, {
              filters: { httpStatus: [200], attributes: { 'usage.org': org(4) } },
            }),
          )
        ).groups;
        checkEqual(group?.requests, 1, 'requests');
      },
    },
    {
      name: 'refuses buckets under an hour and a range under an hour or over 31 days with 403',
      run: async (s) => {
        const day = dayOf(next());
        checkEqual(
          await statusOf(() => s.gateway.query(request(day, 1, { bucketSeconds: 60 }))),
          403,
          'bucket of a minute',
        );
        checkEqual(
          await statusOf(() =>
            s.gateway.query({
              ...request(day, 1),
              timeRange: {
                from: new Date(day).toISOString(),
                to: new Date(day + 30 * 60_000).toISOString(),
              },
            }),
          ),
          403,
          'half an hour',
        );
        checkEqual(await statusOf(() => s.gateway.query(request(day, 32 * 24))), 403, '32 days');
      },
    },
  ],
};

export const memoryUsageContractTarget = async () => {
  const fake = memoryUsageSource();
  return { subject: { gateway: fake, arrange: fake } };
};
