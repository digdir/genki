import type { AuditRow } from '../../api';
import { translator, type PlainKey, type T } from '../../i18n';

const nbT = translator('nb');

const actionKeys: Record<string, PlainKey> = {
  'platform.service.publish': 'changes.publish',
  'platform.setting.set': 'changes.settingSet',
  'platform.setting.unset': 'changes.settingUnset',
  'platform.setting.pin': 'changes.settingPin',
  'platform.tenant.import': 'changes.tenantImport',
  'platform.tenant.create': 'changes.tenantCreate',
  'platform.support.open': 'changes.supportOpen',
  'platform.apikeys.create': 'changes.apikeyCreate',
  'platform.apikeys.revoke': 'changes.apikeyRevoke',
  'platform.hook.save': 'changes.hookSave',
  'platform.tracing.connection.save': 'changes.traceConnectionSave',
  'platform.tracing.connection.remove': 'changes.traceConnectionRemove',
  'platform.tracing.connection.residency': 'changes.traceConnectionResidency',
  'platform.hook.delete': 'changes.hookDelete',
  'platform.hook.publish-check': 'changes.hookPublishCheck',
  'platform.hook.feedback': 'changes.hookFeedback',
  'platform.apikeys.rotate': 'changes.apikeyRotate',
  'platform.audit.export': 'changes.auditExport',
  'platform.block.adopt': 'changes.blockAdopt',
  'platform.block.decide': 'changes.blockDecide',
  'platform.block.request': 'changes.blockRequest',
  'platform.block.settings': 'changes.blockSettings',
  'platform.block-share.request': 'changes.blockShareRequest',
  'platform.block-share.approve': 'changes.blockShareApprove',
  'platform.block-share.decline': 'changes.blockShareDecline',
  'platform.catalog.delete': 'changes.catalogDelete',
  'platform.catalog.publish': 'changes.catalogPublish',
  'platform.provider-object.incident': 'changes.providerObjectIncident',
  'platform.batch-run.start': 'changes.batchRunStart',
  'platform.batch-run.cancel': 'changes.batchRunCancel',
  'platform.batch-run.retry': 'changes.batchRunRetry',
  'platform.clients.webhook-test': 'changes.clientsWebhookTest',
  'platform.quality.matrix.run': 'changes.qualityMatrixRun',
  'platform.operations.try': 'changes.operationTry',
  'platform.operations.maturity': 'changes.operationMaturity',
  'platform.operations.kind.delete': 'changes.operationKindDelete',
  'platform.demo.save': 'changes.demoSave',
  'platform.demo.recording.start': 'changes.demoRecordingStart',
  'platform.demo.recording.finish': 'changes.demoRecordingFinish',
  'platform.operations.processor-record': 'changes.processorRecord',
  'platform.operations.descriptor-upload': 'changes.descriptorUpload',
  'platform.operations.descriptor-status': 'changes.descriptorStatus',
  'platform.operations.descriptor-withdraw': 'changes.descriptorWithdraw',
  'platform.operations.descriptor-fixture': 'changes.descriptorFixture',
  'platform.task.review.approve': 'changes.taskReviewApprove',
  'platform.task.review.edit': 'changes.taskReviewEdit',
  'platform.clients.remove': 'changes.clientsRemove',
  'platform.client.hosted': 'changes.clientHosted',
  'platform.client.hostnames.add': 'changes.clientHostnameAdd',
  'platform.client.hostnames.remove': 'changes.clientHostnameRemove',
  'platform.client.hostnames.bind': 'changes.clientHostnameBind',
  'platform.client.hostnames.verify': 'changes.clientHostnameVerify',
  'platform.client.hostnames.expire': 'changes.clientHostnameExpire',
  'platform.client.hostnames.lapse': 'changes.clientHostnameLapse',
  'platform.service.address': 'changes.serviceAddress',
  'platform.clients.save': 'changes.clientsSave',
  'platform.dataset.enrichment.apply': 'changes.datasetEnrichmentApply',
  'platform.dataset.enrichment.revert': 'changes.datasetEnrichmentRevert',
  'platform.dataset.upload': 'changes.datasetUpload',
  'platform.dataset.upload.delete': 'changes.datasetUploadDelete',
  'platform.dataset.delete': 'changes.datasetDelete',
  'platform.default.set': 'changes.defaultSet',
  'platform.engine-switch.cancel': 'changes.engineSwitchCancel',
  'platform.engine-switch.activate': 'changes.engineSwitchActivate',
  'platform.engine-switch.retry': 'changes.engineSwitchRetry',
  'platform.engine-switch.start': 'changes.engineSwitchStart',
  'platform.engine-switch.readmit': 'changes.engineSwitchReadmit',
  'platform.eval.run': 'changes.evalRun',
  'platform.eval-run.cancel': 'changes.evalRunCancel',
  'platform.gate.delete': 'changes.gateDelete',
  'platform.gate.save': 'changes.gateSave',
  'platform.guardrail-rule.delete': 'changes.guardrailRuleDelete',
  'platform.guardrail-rule.save': 'changes.guardrailRuleSave',
  'platform.improvement.decide': 'changes.improvementDecide',
  'platform.judge.label': 'changes.judgeLabel',
  'platform.judge.label.accept': 'changes.judgeLabelAccept',
  'platform.judge.label.reject': 'changes.judgeLabelReject',
  'platform.keypolicy.attach': 'changes.keypolicyAttach',
  'platform.keypolicy.delete': 'changes.keypolicyDelete',
  'platform.keypolicy.save': 'changes.keypolicySave',
  'platform.maskinporten-client.remove': 'changes.maskinportenClientRemove',
  'platform.maskinporten-client.save': 'changes.maskinportenClientSave',
  'platform.models.classify': 'changes.modelsClassify',
  'platform.models.refresh': 'changes.modelsRefresh',
  'platform.onboarding.decide': 'changes.onboardingDecide',
  'platform.onboarding.request': 'changes.onboardingRequest',
  'platform.pipeline.cancel': 'changes.pipelineCancel',
  'platform.jobs.redrive': 'changes.jobsRedrive',
  'platform.jobs.readmit': 'changes.jobsReadmit',
  'platform.knowledge.fields': 'changes.knowledgeFields',
  'platform.pipeline.delete': 'changes.pipelineDelete',
  'platform.pipeline.execute': 'changes.pipelineExecute',
  'platform.pipeline.save': 'changes.pipelineSave',
  'platform.platform-secret.set': 'changes.platformSecretSet',
  'platform.platform-secret.delete': 'changes.platformSecretDelete',
  'platform.plugin.promote': 'changes.pluginPromote',
  'platform.plugin.register': 'changes.pluginRegister',
  'platform.plugin.remove': 'changes.pluginRemove',
  'platform.plugin.verify': 'changes.pluginVerify',
  'platform.private-networks.save': 'changes.privateNetworksSave',
  'platform.project.create': 'changes.projectCreate',
  'platform.project.delete': 'changes.projectDelete',
  'platform.project.point.add': 'changes.projectPointAdd',
  'platform.project.run.cancel': 'changes.projectRunCancel',
  'platform.project.run.estimate': 'changes.projectRunEstimate',
  'platform.project.run.retry': 'changes.projectRunRetry',
  'platform.project.run.review': 'changes.projectRunReview',
  'platform.project.run.start': 'changes.projectRunStart',
  'platform.project.subscription.check': 'changes.projectSubscriptionCheck',
  'platform.project.subscription.delete': 'changes.projectSubscriptionDelete',
  'platform.project.subscription.pause': 'changes.projectSubscriptionPause',
  'platform.project.subscription.resume': 'changes.projectSubscriptionResume',
  'platform.project.subscription.save': 'changes.projectSubscriptionSave',
  'platform.project.update': 'changes.projectUpdate',
  'platform.proposal.create': 'changes.proposalCreate',
  'platform.proposal.decide': 'changes.proposalDecide',
  'platform.proposal.status': 'changes.proposalStatus',
  'platform.secrets.set': 'changes.secretsSet',
  'platform.secrets.hosts': 'changes.secretsHosts',
  'platform.secrets.delete': 'changes.secretsDelete',
  'platform.service.draft.delete': 'changes.serviceDraftDelete',
  'platform.service.draft.rebase': 'changes.serviceDraftRebase',
  'platform.service.draft.save': 'changes.serviceDraftSave',
  'platform.service.lifecycle': 'changes.serviceLifecycle',
  'platform.service.delete': 'changes.serviceDelete',
  'platform.step-flow.archive': 'changes.stepFlowArchive',
  'platform.service.access': 'changes.serviceAccess',
  'platform.service.environments.add': 'changes.environmentAdd',
  'platform.service.environments.remove': 'changes.environmentRemove',
  'platform.service.environments.promote': 'changes.environmentPromote',
  'platform.service.environments.rollback': 'changes.environmentRollback',
  'platform.service.environments.describe': 'changes.environmentDescribe',
  'platform.service.risk.confirm': 'changes.serviceRiskConfirm',
  'platform.service.share': 'changes.serviceShare',
  'platform.skill.attachment.upload': 'changes.skillAttachmentUpload',
  'platform.skill.copy': 'changes.skillCopy',
  'platform.skill.create': 'changes.skillCreate',
  'platform.skill.draft.save': 'changes.skillDraftSave',
  'platform.skill.fix.apply': 'changes.skillFixApply',
  'platform.skill.fix.propose': 'changes.skillFixPropose',
  'platform.skill.import': 'changes.skillImport',
  'platform.recipe.share': 'changes.recipeShare',
  'platform.recipe.unshare': 'changes.recipeUnshare',
  'platform.skill.share.decide': 'changes.skillShareDecide',
  'platform.skill.share.request': 'changes.skillShareRequest',
  'platform.skill.share.withdraw': 'changes.skillShareWithdraw',
  'platform.skill.testcase.delete': 'changes.skillTestcaseDelete',
  'platform.support.end': 'changes.supportEnd',
  'platform.support.extend': 'changes.supportExtend',
  'platform.task.cancel': 'changes.taskCancel',
  'platform.task.export': 'changes.taskExport',
  'platform.testset.save': 'changes.testsetSave',
  'platform.testcase.propose': 'changes.testcasePropose',
  'platform.testcase.review': 'changes.testcaseReview',
  'platform.tools.approve': 'changes.toolsApprove',
  'platform.tools.register': 'changes.toolsRegister',
  'platform.tools.sync': 'changes.toolsSync',
  'platform.trigger.pause': 'changes.triggerPause',
  'platform.incident.resolve': 'changes.incidentResolve',
  'platform.incident.save': 'changes.incidentSave',
  'platform.flag.person': 'changes.flagPerson',
  'platform.flag.tenant': 'changes.flagTenant',
  'platform.quota.decide': 'changes.quotaDecide',
  'platform.quota.request': 'changes.quotaRequest',
  'platform.run.cancel': 'changes.taskCancel',
  'platform.service.copy': 'logChanges.serviceCopy',
  'platform.tools.revoke': 'logChanges.toolsRevoke',
};

export const auditActionsWithLabels = Object.keys(actionKeys);

const hiddenTargetKinds = new Set(['audit', 'support']);

const keyIssuer = ':urn:genai:legacy-api-key:';

export type ChangeArea = 'services' | 'datasets' | 'access' | 'settings';

export const changeAreas: readonly ChangeArea[] = ['services', 'datasets', 'access', 'settings'];

const areaPrefixes: [string, ChangeArea][] = [
  ['platform.dataset.', 'datasets'],
  ['platform.pipeline.', 'datasets'],
  ['platform.engine-switch.', 'datasets'],
  ['platform.jobs.', 'datasets'],
  ['platform.knowledge.', 'datasets'],
  ['platform.support.', 'access'],
  ['platform.keypolicy.', 'access'],
  ['platform.maskinporten-client.', 'access'],
  ['platform.clients.', 'access'],
  ['platform.setting.', 'settings'],
  ['platform.quota.', 'settings'],
  ['platform.incident.', 'settings'],
  ['platform.flag.', 'settings'],
  ['platform.default.', 'settings'],
  ['platform.tracing.', 'settings'],
  ['platform.secrets.', 'settings'],
  ['platform.private-networks.', 'settings'],
  ['platform.tenant.', 'settings'],
];

export const areaOf = (action: string): ChangeArea =>
  areaPrefixes.find(([prefix]) => action.startsWith(prefix))?.[1] ?? 'services';

const catalogTarget = (target: string) => {
  const found = /^catalog:([a-z_-]+)\/(.+?)(?:@(\d+))?$/.exec(target);
  return found?.[1] && found[2] ? { kind: found[1], id: found[2], version: found[3] } : undefined;
};

const datasetKinds = new Set(['dataset', 'knowledge-endpoint']);

export const areaOfEntry = (entry: Pick<AuditRow, 'action' | 'target'>): ChangeArea =>
  datasetKinds.has(catalogTarget(entry.target)?.kind ?? '') ? 'datasets' : areaOf(entry.action);

const digdirCatalogActions = ['platform.catalog.', 'platform.models.', 'platform.default.'];

/** A change Digdir made to the shared catalogue, not to this organisation. */
export const isDigdirCatalogChange = (entry: Pick<AuditRow, 'action' | 'actor'>) =>
  entry.actor.startsWith('operator:') &&
  digdirCatalogActions.some((prefix) => entry.action.startsWith(prefix));

export const serviceOfTarget = (target: string) =>
  /^Service:([^@/]+)@\d+$/.exec(target)?.[1] ??
  /^service:\d{9}\/([^/]+)$/.exec(target)?.[1] ??
  /^service:([^/]+)\/risk$/.exec(target)?.[1] ??
  /^service-draft:(.+)$/.exec(target)?.[1];

export const keyOfActor = (actor: string) => {
  const at = actor.indexOf(keyIssuer);
  return at < 0 ? undefined : actor.slice(at + keyIssuer.length);
};

export interface ChangeTarget {
  text: string;
  service?: string;
  href?: string;
}

export type CatalogName = (kind: string, id: string) => string | undefined;

export type DatasetRoute = (id: string) => string | undefined;

const targetOf = (
  entry: AuditRow,
  t: T,
  serviceName: (id: string) => string | undefined,
  catalogName: CatalogName,
  datasetRoute: DatasetRoute,
): ChangeTarget | undefined => {
  const target = entry.target;
  if (!target || target === entry.action) return undefined;
  const catalog = catalogTarget(target);
  if (catalog) {
    const name = catalogName(catalog.kind, catalog.id) ?? catalog.id;
    const dataset = catalog.kind === 'dataset' ? datasetRoute(catalog.id) : undefined;
    return {
      text: catalog.version ? t('changes.targetVersion', { name, version: catalog.version }) : name,
      ...(catalog.kind === 'model'
        ? { href: `#/building-blocks/model/${encodeURIComponent(catalog.id)}` }
        : dataset
          ? { href: `#/datasets/${encodeURIComponent(dataset)}` }
          : {}),
    };
  }
  const typed = /^([A-Za-z-]+):(.+)$/.exec(target);
  if (!typed?.[1] || !typed[2]) return undefined;
  if (hiddenTargetKinds.has(typed[1].toLowerCase())) return undefined;
  const version = /@(\d+)$/.exec(target)?.[1];
  const service = serviceOfTarget(target);
  if (service) {
    const name = serviceName(service) ?? service;
    return {
      text: version ? t('changes.targetVersion', { name, version }) : name,
      service,
    };
  }
  const id = typed[2].replace(/^\d{9}\//, '');
  const versioned = /^(.+)@(\d+)$/.exec(id);
  return {
    text:
      versioned?.[1] && versioned[2]
        ? t('changes.targetVersion', { name: versioned[1], version: versioned[2] })
        : id,
  };
};

export const changeParts = (
  entry: AuditRow,
  t: T = nbT,
  serviceName: (id: string) => string | undefined = () => undefined,
  catalogName: CatalogName = () => undefined,
  datasetRoute: DatasetRoute = () => undefined,
) => {
  const key = actionKeys[entry.action];
  const target = targetOf(entry, t, serviceName, catalogName, datasetRoute);
  const version = /^Service:[^@]+@(\d+)$/.exec(entry.target)?.[1];
  const publishedVersion =
    entry.action === 'platform.service.publish' && target?.service ? version : undefined;
  const label = publishedVersion
    ? t('changes.publishVersion', { version: publishedVersion })
    : key
      ? t(key)
      : t('changes.otherAction');
  const shown =
    publishedVersion && target?.service
      ? { ...target, text: serviceName(target.service) ?? target.service }
      : target;
  return {
    label,
    target: shown,
    suffix: entry.outcome === 'rejected' ? t('changes.rejectedSuffix') : '',
  };
};

export const changeText = (entry: AuditRow, t: T = nbT) => {
  const { label, target, suffix } = changeParts(entry, t);
  return `${target ? `${label} ${target.text}` : label}${suffix}`;
};

export const actorOf = (
  entry: AuditRow,
  t: T,
  keyName: (id: string) => string | undefined = () => undefined,
) => {
  const key = keyOfActor(entry.actor);
  if (key !== undefined) {
    const name = keyName(key);
    return name ? t('logRuns.actorApiKey', { name }) : t('logRuns.actorApiKeyUnnamed');
  }
  if (entry.actor.startsWith('operator:')) return t('common.actorOperator');
  if (/^(platform|worker):/.test(entry.actor)) return t('common.actorPlatform');
  if (entry.actor.startsWith('employee:')) return entry.actorName ?? t('common.actorEmployee');
  return t('logRuns.actorSystem');
};

const sameMinutes = 10 * 60_000;

export const collapseRepeats = (entries: AuditRow[]) =>
  entries.filter((e, i) => {
    const before = entries[i - 1];
    return !(
      before &&
      before.actor === e.actor &&
      before.action === e.action &&
      before.target === e.target &&
      before.outcome === e.outcome &&
      before.reason === e.reason &&
      Math.abs(Date.parse(before.at) - Date.parse(e.at)) <= sameMinutes
    );
  });

export const newestFirst = (entries: AuditRow[]) =>
  [...entries].sort((a, b) => b.at.localeCompare(a.at));
