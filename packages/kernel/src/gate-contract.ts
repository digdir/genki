import type { Usage } from '@genai/contracts';
import type { Admission, GateRecord, GateRefusal, PayloadGuard, Residency } from './gate.js';

export const gateContractVersion = 'gate@1';

export const syntheticNationalId = '15838510075';

export interface GateLaneSetup {
  admitted?: boolean;
  enabled?: boolean;
  sharedWith?: string[];
  residency?: Residency;
  routerResidency?: Residency;
  requestResidency?: Residency;
  serviceResidency?: Residency;
  guards?: PayloadGuard[];
  failUpstream?: boolean;
}

export interface GateLaneRun {
  call(text: string, extra?: { media?: boolean }): Promise<string | undefined>;
  upstream: string[];
  metered: Usage[];
  audit: GateRecord[];
}

export interface GateLane {
  port: string;
  operation: string;
  admission: Admission;
  tenant: string;
  has: { enabled: boolean; sharing: boolean; routerResidency: boolean; requestResidency: boolean };
  answersWithText: boolean;
  refusalOf(error: unknown): GateRefusal | undefined;
  open(setup: GateLaneSetup): GateLaneRun;
}

export interface GateContractSubject {
  lanes: GateLane[];
  nationalIdGuard(): PayloadGuard;
}

export interface GateContractCheck {
  name: string;
  run(subject: GateContractSubject, signal: AbortSignal): Promise<unknown>;
}

export interface GateContractSuite {
  contract: string;
  checks: GateContractCheck[];
}

const fail = (message: string): never => {
  throw new Error(message);
};

const refusalOf = async (lane: GateLane, setup: GateLaneSetup, text = 'hei', media = false) => {
  const run = lane.open(setup);
  let refusal: GateRefusal | undefined;
  let refused = false;
  try {
    await run.call(text, { media });
  } catch (error) {
    refused = true;
    refusal = lane.refusalOf(error);
  }
  const record = run.audit.at(-1);
  if (refused && record && (record.outcome !== 'refused' || record.refusal !== refusal))
    fail(`${lane.port}: refused as ${String(refusal)} but audited as ${JSON.stringify(record)}`);
  return { refused, refusal, upstream: run.upstream.length };
};

const expectRefused = async (lane: GateLane, setup: GateLaneSetup, refusal: GateRefusal) => {
  const outcome = await refusalOf(lane, setup);
  if (!outcome.refused) fail(`${lane.port}: the call was not refused (${refusal})`);
  if (outcome.refusal !== refusal)
    fail(`${lane.port}: refused as ${String(outcome.refusal)}, expected ${refusal}`);
  if (outcome.upstream !== 0) fail(`${lane.port}: a refused call reached the provider`);
};

const expectAllowed = async (lane: GateLane, setup: GateLaneSetup) => {
  const outcome = await refusalOf(lane, setup);
  if (outcome.refused)
    fail(`${lane.port}: the call was refused as ${String(outcome.refusal)}, expected it to pass`);
};

const everyLane = async (subject: GateContractSubject, run: (lane: GateLane) => Promise<void>) => {
  if (subject.lanes.length === 0) fail('the subject has no lanes');
  for (const lane of subject.lanes) await run(lane);
};

export const gateContract: GateContractSuite = {
  contract: gateContractVersion,
  checks: [
    {
      name: 'refuses a call in lockdown from a login without model access on a port that requires admission, and lets an open port through',
      run: (s) =>
        everyLane(s, async (lane) => {
          if (lane.admission === 'admitted')
            await expectRefused(lane, { admitted: false }, 'admission');
          else await expectAllowed(lane, { admitted: false });
          await expectAllowed(lane, { admitted: true });
        }),
    },
    {
      name: 'refuses a call to a model that is turned off',
      run: (s) =>
        everyLane(s, async (lane) => {
          if (lane.has.enabled) await expectRefused(lane, { enabled: false }, 'disabled');
        }),
    },
    {
      name: 'refuses a call for a tenant the model is not shared with',
      run: (s) =>
        everyLane(s, async (lane) => {
          if (!lane.has.sharing) fail(`${lane.port}: tenant sharing is not checked`);
          await expectRefused(lane, { sharedWith: ['111222333'] }, 'not-shared');
          await expectAllowed(lane, { sharedWith: [lane.tenant] });
        }),
    },
    {
      name: 'refuses a call outside every residency ceiling: the router, the request and the service',
      run: (s) =>
        everyLane(s, async (lane) => {
          const ceilings: GateLaneSetup[] = [
            ...(lane.has.routerResidency ? [{ routerResidency: 'norway' as const }] : []),
            ...(lane.has.requestResidency ? [{ requestResidency: 'norway' as const }] : []),
            { serviceResidency: 'norway' },
          ];
          for (const ceiling of ceilings) {
            await expectRefused(lane, { residency: 'eu', ...ceiling }, 'residency');
            await expectAllowed(lane, { residency: 'norway', ...ceiling });
          }
        }),
    },
    {
      name: 'checks admission, enabled, sharing and residency in that order',
      run: (s) =>
        everyLane(s, async (lane) => {
          const all: GateLaneSetup = {
            admitted: false,
            enabled: false,
            sharedWith: ['111222333'],
            residency: 'global',
            serviceResidency: 'norway',
          };
          const order: [GateRefusal, keyof GateLaneSetup, unknown][] = [
            ['admission', 'admitted', true],
            ['disabled', 'enabled', true],
            ['not-shared', 'sharedWith', [lane.tenant]],
            ['residency', 'residency', 'norway'],
          ];
          let setup = { ...all };
          for (const [refusal, key, fixed] of order) {
            const applies =
              (refusal !== 'admission' || lane.admission === 'admitted') &&
              (refusal !== 'disabled' || lane.has.enabled);
            if (applies) await expectRefused(lane, setup, refusal);
            setup = { ...setup, [key]: fixed };
          }
          await expectAllowed(lane, setup);
        }),
    },
    {
      name: 'refuses a payload with image, audio or file content before it leaves',
      run: (s) =>
        everyLane(s, async (lane) => {
          const outcome = await refusalOf(lane, {}, 'se på bildet', true);
          if (!outcome.refused) fail(`${lane.port}: a payload with an image was not refused`);
          if (outcome.upstream > 0) fail(`${lane.port}: the image reached the provider`);
          if (outcome.refusal !== 'media')
            fail(`${lane.port}: refused as ${String(outcome.refusal)}`);
        }),
    },
    {
      name: 'no operation sends a valid national id upstream when the service masks national ids',
      run: (s) =>
        everyLane(s, async (lane) => {
          const run = lane.open({ guards: [s.nationalIdGuard()] });
          const answer = await run.call(`Gjelder ${syntheticNationalId} saken?`);
          if (run.upstream.length === 0) fail(`${lane.port}: nothing reached the provider`);
          if (run.upstream.some((text) => text.includes(syntheticNationalId)))
            fail(`${lane.port}: the national id reached the provider`);
          if (lane.answersWithText && !answer?.includes(syntheticNationalId))
            fail(`${lane.port}: the answer did not get the national id back`);
        }),
    },
    {
      name: 'masks once even when a strategy also masks',
      run: (s) =>
        everyLane(s, async (lane) => {
          const question = `Gjelder ${syntheticNationalId} saken?`;
          const guard = s.nationalIdGuard();
          const premasked = guard.masker?.mask(question) ?? fail('the guard has no masker');
          for (const [guards, text] of [
            [[guard, guard], question],
            [[guard], premasked],
          ] as const) {
            const run = lane.open({ guards: [...guards] });
            const answer = await run.call(text);
            const masked = run.upstream.find((t) => t.includes('Gjelder'));
            if (!masked || masked.includes(syntheticNationalId) || masked.split('«').length !== 2)
              fail(`${lane.port}: expected one token in "${String(masked)}"`);
            if (lane.answersWithText && answer !== question)
              fail(`${lane.port}: the answer was restored as "${String(answer)}"`);
          }
        }),
    },
    {
      name: 'meters the usage of every call that reached the provider',
      run: (s) =>
        everyLane(s, async (lane) => {
          const run = lane.open({});
          await run.call('hei');
          if (run.metered.length !== 1) fail(`${lane.port}: metered ${run.metered.length} times`);
          if (!run.metered[0]?.requests) fail(`${lane.port}: the request was not counted`);
        }),
    },
    {
      name: 'writes one kernel.gate.call audit event per call, without payload text',
      run: (s) =>
        everyLane(s, async (lane) => {
          const secret = `hemmelig ${syntheticNationalId}`;
          const ok = lane.open({});
          await ok.call(secret);
          const failed = lane.open({ failUpstream: true });
          await failed.call(secret).catch(() => undefined);
          const refused = lane.open({ serviceResidency: 'norway', residency: 'global' });
          await refused.call(secret).catch(() => undefined);
          const outcomes = [ok, failed, refused].map((r) => r.audit.map((a) => a.outcome));
          if (JSON.stringify(outcomes) !== JSON.stringify([['ok'], ['failed'], ['refused']]))
            fail(`${lane.port}: audit outcomes were ${JSON.stringify(outcomes)}`);
          for (const record of [ok, failed, refused].flatMap((r) => r.audit)) {
            const text = JSON.stringify(record);
            if (text.includes('hemmelig') || text.includes(syntheticNationalId))
              fail(`${lane.port}: the audit event holds payload text`);
            if (record.port !== lane.port || record.operation !== lane.operation)
              fail(`${lane.port}: the audit event names ${record.port}/${record.operation}`);
          }
          if (!ok.audit[0]?.usage) fail(`${lane.port}: the audit event has no usage`);
        }),
    },
  ],
};
