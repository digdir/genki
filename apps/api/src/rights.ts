import type { Principal } from '@genai/contracts';
import {
  carriesAltinnActions,
  isTestRunnerKey,
  PLATFORM_RIGHTS,
  platformRightsOf,
  rightsOnlyFromGrants,
} from '@genai/identity';
import type { Context } from 'hono';
import { platformScope } from './config-store.js';
import { testRunnerMayPerform } from './test-runner.js';

export type Right =
  | 'use-services'
  | 'manage-services'
  | 'manage-datasets'
  | 'register-building-blocks'
  | 'view-usage';

export const rights: readonly Right[] = PLATFORM_RIGHTS;

export const rightLabels: Readonly<Record<Right, string>> = {
  'use-services': 'Bruke tjenester',
  'manage-services': 'Administrere tjenester',
  'manage-datasets': 'Administrere dokumentsamlinger',
  'register-building-blocks': 'Legge til i katalogen',
  'view-usage': 'Se forbruk og kostnad',
};

export interface RightProblem {
  type: 'about:blank';
  title: string;
  status: 403;
  errors: { path: 'right'; message: Right }[];
}

export type RightCheck = { ok: true } | { ok: false; problem: RightProblem };

export const rightsOf = (principal: Principal, tenant: string): Set<Right> =>
  new Set(platformRightsOf(principal, tenant));

const rightProblem = (right: Right): RightProblem => ({
  type: 'about:blank',
  title: `Du trenger rettigheten «${rightLabels[right]}»`,
  status: 403,
  errors: [{ path: 'right', message: right }],
});

export const requireRight = (principal: Principal, tenant: string, right: Right): RightCheck =>
  rightsOf(principal, tenant).has(right)
    ? { ok: true }
    : { ok: false, problem: rightProblem(right) };

export const seesUsage = (principal: Principal, tenant: string) =>
  rightsOf(principal, tenant).has('view-usage');

export const rightRefused = (c: Context, problem: RightProblem) =>
  c.json(problem, 403, { 'content-type': 'application/problem+json' });

export const rightsByOrg = (principal: Principal, orgs: readonly string[]) =>
  Object.fromEntries(orgs.map((org) => [org, [...rightsOf(principal, org)]]));

export type ActionRequirement = 'operator' | Right | readonly Right[] | { anyOf: readonly Right[] };

type ActionInput = Record<string, unknown>;

const datasetKinds = new Set(['dataset', 'knowledge-endpoint', 'search_engine']);
const byKind = (input: ActionInput): Right =>
  datasetKinds.has(String(input.kind)) ? 'manage-datasets' : 'manage-services';
const catalogWrite = (input: ActionInput): ActionRequirement =>
  input.scope === platformScope ? 'operator' : byKind(input);
const datasetWrite = (input: ActionInput): ActionRequirement =>
  input.scope === platformScope ? 'operator' : 'manage-datasets';
const subscriptionRight = (input: ActionInput): Right =>
  input.mode === 'run' ? 'manage-services' : 'use-services';
const toolRegistration = { anyOf: ['register-building-blocks', 'manage-services'] } as const;
const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
const connectionDefaults: Record<string, unknown> = { port: 5432, tls: true };
const connectionFields = ['password', 'host', 'port', 'database', 'user', 'tls'] as const;
const borrowsTenantSecret = (input: ActionInput) => {
  const source = objectOf(objectOf(input.spec).source);
  if (source.kind !== 'database') return false;
  const given = objectOf(source.connection);
  const connector = objectOf(input.connector);
  if (typeof given.password !== 'string') return true;
  return connectionFields.some(
    (field) =>
      (given[field] ?? connectionDefaults[field]) !==
      (connector[field] ?? connectionDefaults[field]),
  );
};
const pipelineSave = (input: ActionInput): ActionRequirement =>
  borrowsTenantSecret(input) ? ['manage-datasets', 'manage-services'] : 'manage-datasets';

export const adminActionRights: Readonly<
  Record<string, ActionRequirement | ((input: ActionInput) => ActionRequirement)>
> = {
  'platform.service.publish': 'manage-services',
  'platform.service.lifecycle': 'manage-services',
  'platform.service.delete': 'manage-services',
  'platform.step-flow.archive': 'manage-services',
  'platform.service.access': 'manage-services',
  'platform.service.environments.add': 'manage-services',
  'platform.service.environments.remove': 'manage-services',
  'platform.service.environments.promote': 'manage-services',
  'platform.service.environments.rollback': 'manage-services',
  'platform.service.environments.describe': 'manage-services',
  'platform.setting.set': 'manage-services',
  'platform.setting.pin': 'manage-services',
  'platform.tenant.import': 'manage-services',
  'platform.tools.register': toolRegistration,
  'platform.tools.sync': toolRegistration,
  'platform.tools.approve': 'manage-services',
  'platform.tools.revoke': 'manage-services',
  'platform.secrets.set': (input) =>
    input.hostsChange === true
      ? 'manage-services'
      : { anyOf: ['manage-services', 'register-building-blocks'] },
  'platform.secrets.hosts': 'manage-services',
  'platform.secrets.delete': { anyOf: ['manage-services', 'register-building-blocks'] },
  'platform.apikeys.create': 'manage-services',
  'platform.apikeys.rotate': 'manage-services',
  'platform.apikeys.revoke': 'manage-services',
  'platform.keypolicy.save': 'manage-services',
  'platform.keypolicy.delete': 'manage-services',
  'platform.keypolicy.attach': 'manage-services',
  'platform.clients.save': 'manage-services',
  'platform.clients.remove': 'manage-services',
  'platform.client.hosted': 'operator',
  'platform.client.hostnames.add': 'manage-services',
  'platform.client.hostnames.remove': 'manage-services',
  'platform.client.hostnames.bind': 'operator',
  'platform.service.address': 'manage-services',
  'platform.maskinporten-client.save': 'manage-services',
  'platform.maskinporten-client.remove': 'manage-services',
  'platform.trigger.pause': 'manage-services',
  'platform.onboarding.request': 'manage-services',
  'platform.gate.save': 'manage-services',
  'platform.gate.delete': 'manage-services',
  'platform.guardrail-rule.save': 'manage-services',
  'platform.guardrail-rule.delete': 'manage-services',
  'platform.testset.save': 'manage-services',
  'platform.improvement.decide': 'manage-services',
  'platform.catalog.publish': catalogWrite,
  'platform.catalog.delete': catalogWrite,
  'platform.pipeline.save': pipelineSave,
  'platform.pipeline.delete': 'manage-datasets',
  'platform.pipeline.execute': 'manage-datasets',
  'platform.pipeline.cancel': 'manage-datasets',
  // Knowledge jobs only: ADR 0042 widens ADR 0041, where only operators send jobs back.
  'platform.jobs.redrive': 'manage-datasets',
  'platform.jobs.readmit': 'manage-datasets',
  // Operators only, through their own route (ADR 0042).
  'platform.knowledge.fields': 'manage-datasets',
  'platform.dataset.upload': 'manage-datasets',
  'platform.dataset.upload.delete': 'manage-datasets',
  'platform.dataset.delete': datasetWrite,
  'platform.dataset.enrichment.apply': 'manage-datasets',
  'platform.dataset.enrichment.revert': 'manage-datasets',
  'platform.batch-run.start': 'manage-services',
  'platform.batch-run.cancel': 'manage-services',
  'platform.batch-run.retry': 'manage-services',
  'platform.engine-switch.start': datasetWrite,
  'platform.engine-switch.retry': datasetWrite,
  'platform.engine-switch.cancel': datasetWrite,
  'platform.engine-switch.readmit': datasetWrite,
  'platform.engine-switch.activate': datasetWrite,
  'platform.testcase.propose': 'manage-services',
  'platform.testcase.review': 'manage-services',
  'platform.service.risk.confirm': 'manage-services',
  'platform.block.adopt': byKind,
  'platform.block.request': byKind,
  'platform.block.settings': byKind,
  'platform.block-share.request': 'manage-services',
  'platform.block-share.approve': 'operator',
  'platform.block-share.decline': 'operator',
  'platform.proposal.create': 'manage-services',
  'platform.proposal.decide': (input) =>
    input.op === 'send-for-approval'
      ? 'use-services'
      : input.op === 'approve' && (input.level === 3 || input.contractTests !== undefined)
        ? ['manage-services', 'register-building-blocks']
        : input.op === 'approve' && input.connector !== undefined
          ? ['manage-services', 'manage-datasets']
          : 'manage-services',
  'platform.service.draft.save': 'manage-services',
  'platform.service.draft.rebase': 'manage-services',
  'platform.service.draft.delete': 'manage-services',
  'platform.skill.create': 'manage-services',
  'platform.skill.import': 'manage-services',
  'platform.skill.draft.save': 'manage-services',
  'platform.skill.testcase.delete': 'manage-services',
  'platform.skill.fix.propose': 'manage-services',
  'platform.skill.fix.apply': 'manage-services',
  'platform.skill.share.request': 'manage-services',
  'platform.skill.share.withdraw': 'manage-services',
  'platform.skill.copy': 'manage-services',
  'platform.skill.attachment.upload': 'manage-services',
  'platform.project.create': 'use-services',
  'platform.project.update': 'use-services',
  'platform.project.delete': 'use-services',
  'platform.project.point.add': 'use-services',
  'platform.project.run.estimate': 'use-services',
  'platform.project.run.start': 'use-services',
  'platform.project.run.cancel': 'use-services',
  'platform.project.run.retry': 'use-services',
  'platform.project.run.review': 'use-services',
  'platform.project.subscription.save': subscriptionRight,
  'platform.project.subscription.delete': subscriptionRight,
  'platform.project.subscription.pause': subscriptionRight,
  'platform.project.subscription.resume': subscriptionRight,
  'platform.project.subscription.check': subscriptionRight,
  'platform.default.set': 'operator',
  'platform.tracing.connection.save': 'manage-services',
  'platform.tracing.connection.remove': 'manage-services',
  'platform.tracing.connection.residency': 'operator',
  'platform.content.reason': 'operator',
  'platform.models.refresh': 'operator',
  'platform.models.classify': 'operator',
  'platform.tenant.create': 'operator',
  'platform.onboarding.decide': 'operator',
  'platform.skill.share.decide': 'operator',
  'platform.recipe.share': 'operator',
  'platform.recipe.unshare': 'operator',
  'platform.platform-secret.set': 'operator',
  'platform.platform-secret.delete': 'operator',
  'platform.operations.kind.delete': 'operator',
  'platform.block.decide': 'operator',
  'platform.proposal.status': 'operator',
  'platform.service.share': 'operator',
  'platform.private-networks.save': 'operator',
  'platform.judge.label': 'operator',
  'platform.judge.label.accept': 'operator',
  'platform.judge.label.reject': 'operator',
  'platform.task.cancel': 'operator',
  'platform.audit.export': 'operator',
  'platform.task.export': 'manage-services',
  'platform.task.review.edit': 'use-services',
  'platform.task.review.approve': 'use-services',
  'platform.run.cancel': (input) => (input.own === true ? 'use-services' : 'manage-services'),
  'platform.eval-run.cancel': (input) => (input.own === true ? 'use-services' : 'manage-services'),
  'platform.quota.request': 'manage-services',
  'platform.quota.decide': 'operator',
  'platform.flag.person': { anyOf: PLATFORM_RIGHTS },
  'platform.flag.tenant': 'manage-services',
  'platform.incident.save': 'operator',
  'platform.incident.resolve': 'operator',
  'platform.clients.webhook-test': 'manage-services',
  'platform.quality.matrix.run': 'operator',
  'platform.operations.try': 'operator',
  'platform.demo.save': 'operator',
  'platform.demo.recording.start': 'operator',
  'platform.demo.recording.finish': 'operator',
  'platform.operations.maturity': 'operator',
  'platform.operations.processor-record': 'operator',
  'platform.operations.descriptor-upload': 'operator',
  'platform.operations.descriptor-status': 'operator',
  'platform.operations.descriptor-withdraw': 'operator',
  'platform.operations.descriptor-fixture': 'operator',
  'platform.plugin.verify': 'operator',
  'platform.plugin.register': 'operator',
  'platform.plugin.remove': 'operator',
  'platform.plugin.promote': 'operator',
  'platform.hook.feedback': 'manage-services',
  'platform.hook.publish-check': 'manage-services',
  'platform.hook.save': (input) => (input.scope === platformScope ? 'operator' : 'manage-services'),
  'platform.hook.delete': (input) =>
    input.scope === platformScope ? 'operator' : 'manage-services',
};

export const actionRequirement = (action: string, input: ActionInput): ActionRequirement => {
  const entry = adminActionRights[action] ?? 'manage-services';
  return typeof entry === 'function' ? entry(input) : entry;
};

export const rightsAreChecked = (principal: Principal) =>
  carriesAltinnActions(principal) || rightsOnlyFromGrants(principal);

export const isOperator = (principal: Principal) =>
  principal.kind === 'operator' || principal.actor?.kind === 'operator';

export type ActionRefusal =
  | { kind: 'operator' }
  | { kind: 'test-runner' }
  | { kind: 'right'; right: Right; problem: RightProblem };

export const refusedAction = (
  principal: Principal,
  action: string,
  tenant: string,
  input: ActionInput,
): ActionRefusal | undefined => {
  if (isTestRunnerKey(principal))
    return testRunnerMayPerform(action, input) ? undefined : { kind: 'test-runner' };
  if (isOperator(principal) || !rightsAreChecked(principal)) return undefined;
  const requirement = actionRequirement(action, input);
  if (requirement === 'operator') return { kind: 'operator' };
  const held = rightsOf(principal, tenant);
  const missing =
    typeof requirement === 'string'
      ? held.has(requirement)
        ? undefined
        : requirement
      : 'anyOf' in requirement
        ? requirement.anyOf.some((r) => held.has(r))
          ? undefined
          : requirement.anyOf[0]
        : requirement.find((r) => !held.has(r));
  return missing ? { kind: 'right', right: missing, problem: rightProblem(missing) } : undefined;
};
