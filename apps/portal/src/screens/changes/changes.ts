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
  'platform.hook.delete': 'changes.hookDelete',
  'platform.hook.publish-check': 'changes.hookPublishCheck',
  'platform.hook.feedback': 'changes.hookFeedback',
  'platform.apikeys.rotate': 'changes.apikeyRotate',
  'platform.audit.export': 'changes.auditExport',
  'platform.block.adopt': 'changes.blockAdopt',
  'platform.block.decide': 'changes.blockDecide',
  'platform.block.request': 'changes.blockRequest',
  'platform.block.settings': 'changes.blockSettings',
  'platform.catalog.delete': 'changes.catalogDelete',
  'platform.catalog.publish': 'changes.catalogPublish',
  'platform.batch-run.start': 'changes.batchRunStart',
  'platform.batch-run.cancel': 'changes.batchRunCancel',
  'platform.batch-run.retry': 'changes.batchRunRetry',
  'platform.clients.webhook-test': 'changes.clientsWebhookTest',
  'platform.quality.matrix.run': 'changes.qualityMatrixRun',
  'platform.task.review.approve': 'changes.taskReviewApprove',
  'platform.task.review.edit': 'changes.taskReviewEdit',
  'platform.clients.remove': 'changes.clientsRemove',
  'platform.clients.save': 'changes.clientsSave',
  'platform.dataset.enrichment.apply': 'changes.datasetEnrichmentApply',
  'platform.dataset.enrichment.revert': 'changes.datasetEnrichmentRevert',
  'platform.dataset.upload': 'changes.datasetUpload',
  'platform.dataset.upload.delete': 'changes.datasetUploadDelete',
  'platform.default.set': 'changes.defaultSet',
  'platform.engine-switch.cancel': 'changes.engineSwitchCancel',
  'platform.engine-switch.retry': 'changes.engineSwitchRetry',
  'platform.engine-switch.start': 'changes.engineSwitchStart',
  'platform.eval.run': 'changes.evalRun',
  'platform.gate.delete': 'changes.gateDelete',
  'platform.gate.save': 'changes.gateSave',
  'platform.guardrail-rule.delete': 'changes.guardrailRuleDelete',
  'platform.guardrail-rule.save': 'changes.guardrailRuleSave',
  'platform.improvement.decide': 'changes.improvementDecide',
  'platform.judge.label': 'changes.judgeLabel',
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
  'platform.pipeline.delete': 'changes.pipelineDelete',
  'platform.pipeline.execute': 'changes.pipelineExecute',
  'platform.pipeline.save': 'changes.pipelineSave',
  'platform.platform-secret.set': 'changes.platformSecretSet',
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
  'platform.secrets.delete': 'changes.secretsDelete',
  'platform.service.draft.delete': 'changes.serviceDraftDelete',
  'platform.service.draft.rebase': 'changes.serviceDraftRebase',
  'platform.service.draft.save': 'changes.serviceDraftSave',
  'platform.service.lifecycle': 'changes.serviceLifecycle',
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
};

export const auditActionsWithLabels = Object.keys(actionKeys);

const hiddenTargetKinds = new Set(['audit', 'support']);

const targetText = (entry: AuditRow, t: T) => {
  const target = entry.target;
  if (!target || target === entry.action) return '';
  const typed = /^([A-Za-z-]+):(.+)$/.exec(target);
  if (!typed?.[1] || !typed[2]) return target;
  if (hiddenTargetKinds.has(typed[1].toLowerCase())) return '';
  const id = typed[2].replace(/^\d{9}\//, '');
  const versioned = /^(.+)@(\d+)$/.exec(id);
  return versioned?.[1] && versioned[2]
    ? t('changes.targetVersion', { name: versioned[1], version: versioned[2] })
    : id;
};

export const changeText = (entry: AuditRow, t: T = nbT) => {
  const key = actionKeys[entry.action];
  const label = key ? t(key) : t('changes.otherAction');
  const target = targetText(entry, t);
  return target ? `${label} ${target}` : label;
};

export const newestFirst = (entries: AuditRow[]) =>
  [...entries].sort((a, b) => b.at.localeCompare(a.at));
