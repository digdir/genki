import {
  environmentTierOf,
  isTestOnProductionAnsattporten,
  productionAnsattporten,
  productionLoginSwitchId,
  productionLoginSwitchKind,
  productionLoginSwitchOf,
} from '@genai/composition';
import type { DefinitionStore } from '@genai/definitions';
import { triggerId, triggerPauseKind, triggerTarget } from '@genai/jobs';
import { appendVersion, platformScope, type ConfigEntryStore } from './config-store.js';
import type { AuditEntry } from './admin.js';
import { maskinportenClientKind } from './maskinporten-clients.js';

export { productionAnsattporten };

export const testIdEraReason = 'TestID-era credential revoked at the production login switch';

export const testIdEraResetReason =
  'Back on test Ansattporten: the next production login switch revokes again';

const actor = 'platform:production-login-switch';
const markerKind = productionLoginSwitchKind;
const markerId = productionLoginSwitchId;
const pipelineKind = 'ingestion-pipeline';

type Env = Record<string, string | undefined>;

interface Marker {
  state: 'running' | 'done';
  since: string;
}

export interface TestIdEraDeps {
  platformTenant: string;
  apiKeys: {
    unadmitted(): Promise<{ tenant: string; id: string; digest: string }[]>;
    revoke(tenant: string, id: string, at: string): Promise<unknown>;
  };
  configuredKeys: ReadonlySet<string>;
  config: ConfigEntryStore;
  definitions: Pick<DefinitionStore, 'capabilities' | 'list' | 'get'>;
  audit(entry: AuditEntry): Promise<void>;
  audited(tenant: string): Promise<AuditEntry[]>;
  now: () => Date;
  newId: () => string;
}

export interface TestIdEraRevoked {
  keys: number;
  clients: number;
  schedules: number;
  triggers: number;
}

/** Only genki-test's switch from test to production Ansattporten, never prod's first start. */
export const revokesTestIdEra = (env: Env, entraOnly: boolean) =>
  isTestOnProductionAnsattporten(env) && entraOnly;

export const forgetsTestIdEraRevocation = (env: Env) =>
  environmentTierOf(env) === 'test' && env.ANSATTPORTEN_ISSUER !== productionAnsattporten;

type MarkerDeps = Pick<TestIdEraDeps, 'platformTenant' | 'config' | 'audit' | 'now' | 'newId'>;

const markerOf = (deps: MarkerDeps) => productionLoginSwitchOf(deps.config, deps.platformTenant);

const writeMarker = async (
  deps: MarkerDeps,
  version: number,
  marker: Marker | undefined,
  reason: string,
) =>
  appendVersion(deps.config, {
    kind: markerKind,
    scope: deps.platformTenant,
    id: markerId,
    spec: marker ?? {},
    deleted: marker === undefined,
    by: actor,
    reason,
    at: deps.now().toISOString(),
    ifVersion: version,
  });

/** After an undo to test Ansattporten, so switching again revokes what was made meanwhile. */
export const forgetTestIdEraRevocation = async (deps: MarkerDeps): Promise<boolean> => {
  const marker = await markerOf(deps);
  if (!marker || marker.deleted) return false;
  await deps.audit({
    task: deps.newId(),
    tenant: deps.platformTenant,
    action: 'platform.production-login.reset',
    actor,
    at: deps.now().toISOString(),
    outcome: 'applied',
    target: `${markerKind}:${markerId}`,
    reason: testIdEraResetReason,
  });
  await writeMarker(deps, marker.version, undefined, testIdEraResetReason);
  return true;
};

export const revokeTestIdEra = async (
  deps: TestIdEraDeps,
): Promise<TestIdEraRevoked | undefined> => {
  const marker = await markerOf(deps);
  const found = marker && !marker.deleted ? (marker.spec as Marker) : undefined;
  if (found?.state === 'done') return undefined;
  const at = deps.now().toISOString();
  const since = found?.since ?? at;
  const version = found
    ? (marker?.version ?? 0)
    : (await writeMarker(deps, marker?.version ?? 0, { state: 'running', since }, testIdEraReason))
        .version;

  const auditedTargets = new Map<string, Set<string>>();
  const alreadyAudited = async (tenant: string, target: string) => {
    let targets = auditedTargets.get(tenant);
    if (!targets) {
      targets = new Set(
        (await deps.audited(tenant))
          .filter((a) => a.reason === testIdEraReason && a.at >= since)
          .map((a) => a.target),
      );
      auditedTargets.set(tenant, targets);
    }
    return targets.has(target);
  };
  /** The audit entry first, once per run, so a crash never leaves a change without one. */
  const step = async (tenant: string, action: string, target: string, change: () => unknown) => {
    if (!(await alreadyAudited(tenant, target)))
      await deps.audit({
        task: deps.newId(),
        tenant,
        action,
        actor,
        at,
        outcome: 'applied',
        target,
        reason: testIdEraReason,
      });
    await change();
  };

  let keys = 0;
  for (const key of await deps.apiKeys.unadmitted()) {
    if (deps.configuredKeys.has(key.digest)) continue;
    await step(key.tenant, 'platform.apikeys.revoke', `api-key:${key.tenant}/${key.id}`, () =>
      deps.apiKeys.revoke(key.tenant, key.id, at),
    );
    keys += 1;
  }

  let clients = 0;
  for (const entry of await deps.config.latest({ kind: maskinportenClientKind })) {
    if (entry.deleted || (entry.spec as { admittedInLockdown?: boolean }).admittedInLockdown)
      continue;
    await step(
      entry.scope,
      'platform.maskinporten-client.remove',
      `maskinporten-client:${entry.scope}/${entry.id}`,
      () =>
        appendVersion(deps.config, {
          kind: entry.kind,
          scope: entry.scope,
          id: entry.id,
          spec: entry.spec,
          deleted: true,
          by: actor,
          reason: testIdEraReason,
          at,
          ifVersion: entry.version,
        }),
    );
    clients += 1;
  }

  let schedules = 0;
  for (const entry of await deps.config.latest({ kind: pipelineKind })) {
    const spec = entry.spec as { schedule?: string };
    if (
      entry.deleted ||
      entry.scope === deps.platformTenant ||
      entry.scope === platformScope ||
      !spec.schedule ||
      spec.schedule === 'none'
    )
      continue;
    await step(
      entry.scope,
      'platform.pipeline.save',
      `pipeline:${entry.id.replace('#', '/')}`,
      () =>
        appendVersion(deps.config, {
          kind: entry.kind,
          scope: entry.scope,
          id: entry.id,
          spec: { ...spec, schedule: 'none' },
          deleted: false,
          by: actor,
          reason: testIdEraReason,
          at,
          ifVersion: entry.version,
        }),
    );
    schedules += 1;
  }

  let triggers = 0;
  const tenants = new Set((await deps.definitions.capabilities()).map((c) => c.service.tenant));
  tenants.delete(deps.platformTenant);
  for (const tenant of tenants)
    for (const { kind, id: service } of await deps.definitions.list(tenant)) {
      if (kind !== 'Service') continue;
      const published = await deps.definitions.get('Service', tenant, service);
      if (published?.definition.kind !== 'Service') continue;
      for (const trigger of published.definition.spec.triggers) {
        if (trigger.kind !== 'schedule') continue;
        const id = triggerId(service, trigger);
        const pause = (await deps.config.history(triggerPauseKind, tenant, id)).at(-1);
        if (pause && !pause.deleted) continue;
        await step(tenant, 'platform.trigger.pause', `trigger:${tenant}/${id}`, () =>
          appendVersion(deps.config, {
            kind: triggerPauseKind,
            scope: tenant,
            id,
            spec: { service, kind: trigger.kind, target: triggerTarget(trigger) },
            deleted: false,
            by: actor,
            reason: testIdEraReason,
            at,
            ifVersion: pause?.version ?? 0,
          }),
        );
        triggers += 1;
      }
    }

  const revoked = { keys, clients, schedules, triggers };
  await writeMarker(deps, version, { state: 'done', since }, testIdEraReason);
  return revoked;
};
