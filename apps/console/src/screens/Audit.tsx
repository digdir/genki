import { useFormat } from '@genai/i18n/react';
import { useId, useRef, useState } from 'react';
import type { ApiClient } from '../api';
import { definitionKindParams, type DefinitionKind } from '../definition-kinds';
import { useAsync } from '../hooks';
import type { AuditQuery } from '../operator-types';
import { useT, type PlainKey, type T } from '../i18n';
import { ErrorState, Loading } from '../states';
import { tenantLabel, useTenantNames } from '../tenant-names';
import type { AuditEntry } from '../types';
import { Flash, isMissing, useFlash } from '../ui';
import { Chip, clock, dayMonth, orgHref, useKept } from './operate/parts';
import './operate/operate.css';

export const actionKey: Record<string, PlainKey> = {
  'platform.service.publish': 'audit.actionServicePublish',
  'platform.service.share': 'audit.actionServiceShare',
  'platform.setting.set': 'audit.actionSettingSet',
  'platform.setting.pin': 'audit.actionSettingPin',
  'platform.default.set': 'audit.actionDefaultSet',
  'platform.tenant.import': 'audit.actionTenantImport',
  'platform.tenant.create': 'audit.actionTenantCreate',
  'platform.tenant.move': 'audit.actionTenantMove',
  'platform.content.read': 'audit.actionContentRead',
  'platform.content.reason': 'audit.actionContentReason',
  'platform.models.refresh': 'audit.actionModelsRefresh',
  'platform.models.classify': 'audit.actionModelsClassify',
  'platform.apikeys.create': 'audit.actionApikeysCreate',
  'platform.apikeys.revoke': 'audit.actionApikeysRevoke',
  'platform.apikeys.rotate': 'audit.actionApikeysRotate',
  'platform.audit.export': 'audit.actionAuditExport',
  'platform.block.adopt': 'audit.actionBlockAdopt',
  'platform.block.decide': 'audit.actionBlockDecide',
  'platform.block.request': 'audit.actionBlockRequest',
  'platform.block.settings': 'audit.actionBlockSettings',
  'platform.block-share.request': 'audit.actionBlockShareRequest',
  'platform.block-share.approve': 'audit.actionBlockShareApprove',
  'platform.block-share.decline': 'audit.actionBlockShareDecline',
  'platform.catalog.publish': 'audit.actionCatalogPublish',
  'platform.catalog.delete': 'audit.actionCatalogDelete',
  'platform.clients.save': 'audit.actionClientsSave',
  'platform.clients.remove': 'audit.actionClientsRemove',
  'platform.dataset.upload': 'audit.actionDatasetUpload',
  'platform.dataset.upload.delete': 'audit.actionDatasetUploadDelete',
  'platform.eval.run': 'audit.actionEvalRun',
  'platform.gate.save': 'audit.actionGateSave',
  'platform.gate.delete': 'audit.actionGateDelete',
  'platform.guardrail-rule.save': 'audit.actionGuardrailRuleSave',
  'platform.guardrail-rule.delete': 'audit.actionGuardrailRuleDelete',
  'platform.improvement.decide': 'audit.actionImprovementDecide',
  'platform.judge.label': 'audit.actionJudgeLabel',
  'platform.judge.label.accept': 'audit.actionJudgeLabelAccept',
  'platform.judge.label.reject': 'audit.actionJudgeLabelReject',
  'platform.pipeline.save': 'audit.actionPipelineSave',
  'platform.pipeline.delete': 'audit.actionPipelineDelete',
  'platform.pipeline.execute': 'audit.actionPipelineExecute',
  'platform.proposal.create': 'audit.actionProposalCreate',
  'platform.proposal.decide': 'audit.actionProposalDecide',
  'platform.proposal.status': 'audit.actionProposalStatus',
  'platform.secrets.set': 'audit.actionSecretsSet',
  'platform.task.cancel': 'audit.actionTaskCancel',
  'platform.testset.save': 'audit.actionTestsetSave',
  'platform.tools.approve': 'audit.actionToolsApprove',
  'platform.tools.revoke': 'audit.actionToolsRevoke',
  'platform.tools.register': 'audit.actionToolsRegister',
  'platform.tools.sync': 'audit.actionToolsSync',
  'platform.dataset.enrichment.apply': 'audit.actionDatasetEnrichmentApply',
  'platform.dataset.enrichment.revert': 'audit.actionDatasetEnrichmentRevert',
  'platform.hook.delete': 'audit.actionHookDelete',
  'platform.hook.publish-check': 'audit.actionHookPublishCheck',
  'platform.hook.save': 'audit.actionHookSave',
  'platform.keypolicy.attach': 'audit.actionKeypolicyAttach',
  'platform.keypolicy.delete': 'audit.actionKeypolicyDelete',
  'platform.keypolicy.save': 'audit.actionKeypolicySave',
  'platform.maskinporten-client.remove': 'audit.actionMaskinportenClientRemove',
  'platform.maskinporten-client.save': 'audit.actionMaskinportenClientSave',
  'platform.onboarding.decide': 'audit.actionOnboardingDecide',
  'platform.onboarding.request': 'audit.actionOnboardingRequest',
  'platform.pipeline.cancel': 'audit.actionPipelineCancel',
  'platform.jobs.redrive': 'audit.actionJobsRedrive',
  'platform.jobs.readmit': 'audit.actionJobsReadmit',
  'platform.knowledge.fields': 'audit.actionKnowledgeFields',
  'platform.engine-switch.readmit': 'audit.actionEngineSwitchReadmit',
  'platform.platform-secret.set': 'audit.actionPlatformSecretSet',
  'platform.plugin.register': 'audit.actionPluginRegister',
  'platform.plugin.remove': 'audit.actionPluginRemove',
  'platform.plugin.verify': 'audit.actionPluginVerify',
  'platform.plugin.promote': 'audit.actionPluginPromote',
  'platform.hook.feedback': 'audit.actionHookFeedback',
  'platform.private-networks.save': 'audit.actionPrivateNetworksSave',
  'platform.service.lifecycle': 'audit.actionServiceLifecycle',
  'platform.service.delete': 'audit.actionServiceDelete',
  'platform.service.environments.add': 'audit.actionServiceEnvironmentAdd',
  'platform.service.environments.remove': 'audit.actionServiceEnvironmentRemove',
  'platform.service.environments.promote': 'audit.actionServiceEnvironmentPromote',
  'platform.service.environments.rollback': 'audit.actionServiceEnvironmentRollback',
  'platform.service.environments.describe': 'audit.actionServiceEnvironmentDescribe',
  'platform.skill.share.decide': 'audit.actionSkillShareDecide',
  'platform.recipe.share': 'audit.actionRecipeShare',
  'platform.recipe.unshare': 'audit.actionRecipeUnshare',
  'platform.trigger.pause': 'audit.actionTriggerPause',
  'platform.production-login.reset': 'audit.actionProductionLoginReset',
  'platform.operations.descriptor-upload': 'audit.actionDescriptorUpload',
  'platform.operations.descriptor-status': 'audit.actionDescriptorStatus',
  'platform.operations.descriptor-withdraw': 'audit.actionDescriptorWithdraw',
  'platform.operations.descriptor-fixture': 'audit.actionDescriptorFixture',
  'platform.operations.try': 'audit.actionOperationTry',
  'platform.operations.maturity': 'audit.actionOperationMaturity',
  'platform.operations.processor-record': 'audit.actionProcessorRecord',
};

const catalogActionKey: Record<string, PlainKey> = {
  'platform.catalog.publish:model-endpoint': 'audit.actionModelEndpointSave',
  'platform.catalog.delete:model-endpoint': 'audit.actionModelEndpointRemove',
  'platform.catalog.publish:model': 'audit.actionCatalogModelSave',
  'platform.catalog.delete:model': 'audit.actionCatalogModelRemove',
  'platform.catalog.publish:price': 'audit.actionModelPriceSave',
};

const catalogChangeKey: Record<string, PlainKey> = {
  'model-endpoint': 'audit.actionModelEndpointChange',
  model: 'audit.actionCatalogModelChange',
};

const keyOf = (e: AuditEntry) => {
  const [, kind, version] = /^catalog:([a-z-]+)\/[^@]*(?:@(\d+))?$/.exec(e.target) ?? [];
  const changed =
    e.action === 'platform.catalog.publish' && version && version !== '1' && kind
      ? catalogChangeKey[kind]
      : undefined;
  return changed ?? (kind && catalogActionKey[`${e.action}:${kind}`]) ?? actionKey[e.action];
};

const flagLabelKey = (e: AuditEntry): PlainKey | undefined => {
  if (e.action !== 'platform.flag.person' && e.action !== 'platform.flag.tenant') return undefined;
  const on = e.flag?.on;
  if (on === null) return 'audit.actionFlagUnset';
  return on === undefined
    ? 'audit.actionFlagChange'
    : on
      ? 'audit.actionFlagOn'
      : 'audit.actionFlagOff';
};

export const labelOf = (e: AuditEntry, t: T) => {
  const flagKey = flagLabelKey(e);
  if (flagKey) return t(flagKey);
  const key = keyOf(e);
  return e.actionLabel ?? (key ? t(key) : t('audit.otherAction'));
};
const flagTargetOf = (e: AuditEntry, t: T) => {
  const key = /^flag:([^:]+)/.exec(e.target)?.[1];
  if (!key) return undefined;
  const person = e.flag?.person;
  if (!person) return key;
  const who = person.self ? t('audit.flagSelf') : person.name;
  return who ? t('audit.flagTargetPerson', { key, who }) : key;
};

const targetOf = (e: AuditEntry, t: T) => {
  if (!e.target || e.target === e.action) return '–';
  const flag = flagTargetOf(e, t);
  if (flag) return flag;
  const governed = /^(?:operation-descriptor|operation-kind|operation):(.+)$/.exec(e.target)?.[1];
  if (governed) return governed;
  const catalogued = /^catalog:(?:model-endpoint|model|price)\/(.+?)(?:@\d+)?$/.exec(e.target)?.[1];
  if (catalogued) return catalogued;
  const connection = /^model-endpoint:(.+)\/processor-record$/.exec(e.target)?.[1];
  if (connection) return connection;
  const found = /^(service|model|setting|pin|default|tenant|support):(.+)$/.exec(e.target);
  if (!found?.[1] || !found[2]) return e.target;
  if (found[1] === 'support') return '–';
  if (found[1] === 'service') return found[2].split('/').pop() ?? found[2];
  return found[1] === 'default' ? found[2].replace(/@\d+$/, '') : found[2];
};

const definitionTarget = (e: AuditEntry) => {
  const found = /^(Service|StepFlow|Skill|Block):(.+)@(\d+)$/.exec(e.target);
  return found && found[2] && found[3]
    ? {
        kind: definitionKindParams[found[1] as DefinitionKind],
        id: found[2],
        version: found[3],
      }
    : undefined;
};

export const targetTextOf = (e: AuditEntry, t: T) => {
  const found = definitionTarget(e);
  return found
    ? `${found.id} (${t('audit.targetVersion', { version: found.version })})`
    : targetOf(e, t);
};

const describe = (name: (orgNumber: string) => string, t: T) => {
  const tenantOf = (e: AuditEntry) =>
    e.tenantName === 'Alle' || e.tenant === 'alle'
      ? t('common.allTenants')
      : tenantLabel(e.tenant, e.tenantName ?? name(e.tenant), t);
  const orgOf = (e: AuditEntry) =>
    e.actorOrg ?? (e.actor.startsWith('operator:') ? 'Digdir' : tenantOf(e));
  const personOf = (e: AuditEntry) =>
    e.actorName ??
    (/^(platform|worker):/.test(e.actor)
      ? t('audit.platformActor')
      : t('audit.personIn', { org: orgOf(e) }));
  return { tenantOf, orgOf, personOf };
};

type ActionFilter = 'all' | 'limit' | 'content' | 'flag' | 'publish';

const actionFilters: Record<ActionFilter, { label: PlainKey; prefix?: string }> = {
  all: { label: 'auditLog.all' },
  limit: { label: 'auditLog.actionLimit', prefix: 'platform.setting' },
  content: { label: 'auditLog.actionContent', prefix: 'platform.content.read' },
  flag: { label: 'auditLog.actionFlag', prefix: 'platform.flag' },
  publish: { label: 'auditLog.actionPublish', prefix: 'platform.service.publish' },
};

type WhoFilter = 'all' | 'operator' | 'tenant';

const pageSize = 100;
const exportPage = 500;

const isoDay = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });

const defaultFrom = (now: Date) => {
  const [y, m] = isoDay(now).split('-').map(Number) as [number, number];
  const back = new Date(Date.UTC(y, m - 3, 1));
  return back.toISOString().slice(0, 10);
};

export const Audit = ({ api, now = () => new Date() }: { api: ApiClient; now?: () => Date }) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const tRef = useRef(t);
  tRef.current = t;
  const { tenantOf, orgOf, personOf } = describe(useTenantNames(api), t);
  const [tenants] = useAsync((signal) => api.listTenants(signal), [api]);
  const [today] = useState(() => isoDay(now()));
  const [tenantText, setTenantText] = useState('');
  const [action, setAction] = useState<ActionFilter>('all');
  const [who, setWho] = useState<WhoFilter>('all');
  const [from, setFrom] = useState(() => defaultFrom(now()));
  const [to, setTo] = useState(today);
  const [limit, setLimit] = useState(pageSize);
  const [exporting, setExporting] = useState(false);
  const flash = useFlash();
  const known = tenants.status === 'ready' ? tenants.data : [];
  const typed = tenantText.trim().toLowerCase();
  const tenant = typed
    ? known.find((x) => x.name.toLowerCase() === typed || x.orgNumber === typed.replace(/\s/g, ''))
        ?.orgNumber
    : undefined;
  const unknownTenant = Boolean(typed) && tenants.status === 'ready' && !tenant;
  const blocked = Boolean(typed) && !tenant;
  const query: AuditQuery = {
    ...(tenant ? { tenant } : {}),
    ...(actionFilters[action].prefix ? { action: actionFilters[action].prefix } : {}),
    ...(who === 'all' ? {} : { by: who }),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  const key = JSON.stringify(query);
  const [state, retry] = useAsync(
    (signal) =>
      blocked
        ? Promise.resolve({ data: [], total: 0 })
        : api.auditPage({ ...query, limit }, signal),
    [api, key, limit, blocked],
  );
  const page = useKept(state);
  const reset = () => {
    setTenantText('');
    setAction('all');
    setWho('all');
    setFrom(defaultFrom(now()));
    setTo(today);
    setLimit(pageSize);
  };
  const changeFilter = (apply: () => void) => {
    apply();
    setLimit(pageSize);
  };
  const handling = (e: AuditEntry) => {
    const label = labelOf(e, t);
    if (e.action.startsWith('platform.content.')) return label;
    const target = targetTextOf(e, t);
    return target && target !== '–'
      ? t('auditLog.actionWithTarget', { action: label, target })
      : label;
  };
  const whoOf = (e: AuditEntry) =>
    e.actorName && orgOf(e) === 'Digdir'
      ? t('auditLog.digdirPerson', { name: e.actorName })
      : personOf(e);
  const exportCsv = async () => {
    if (exporting || blocked) return;
    setExporting(true);
    try {
      const rows: AuditEntry[] = [];
      for (let offset = 0; ; offset += exportPage) {
        const next = await api.auditPage({ ...query, limit: exportPage, offset });
        rows.push(...next.data);
        if (next.data.length < exportPage || rows.length >= next.total) break;
      }
      const csv = [
        t('audit.csvHeader'),
        ...rows.map((e) =>
          [e.at, personOf(e), orgOf(e), tenantOf(e), labelOf(e, t), targetTextOf(e, t), e.reason]
            .map(
              (v) =>
                `"${String(v)
                  .replace(/^[=+\-@\t\r]/, "'$&")
                  .replace(/"/g, '""')}"`,
            )
            .join(';'),
        ),
      ].join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
      a.download = t('audit.csvFile');
      a.click();
      await api.logAuditExport(rows.length).catch(() => undefined);
      flash.show(tRef.current('audit.downloaded'));
    } catch {
      flash.show(tRef.current('audit.downloadFailed'), 'danger');
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="op-page">
      <div className="op-head">
        <h1>{t('auditLog.title')}</h1>
        <button
          type="button"
          className="op-btn"
          aria-disabled={exporting || undefined}
          onClick={() => void exportCsv()}
        >
          {t('auditLog.export')}
        </button>
      </div>
      <Flash message={flash.message} />
      <div className="op-filters">
        <div className="op-field grow-small">
          <label htmlFor={`${id}-org`}>{t('auditLog.tenant')}</label>
          <input
            id={`${id}-org`}
            className="op-input"
            type="text"
            list={`${id}-orgs`}
            placeholder={t('auditLog.tenantPlaceholder')}
            value={tenantText}
            aria-invalid={unknownTenant || undefined}
            aria-describedby={unknownTenant ? `${id}-org-e` : undefined}
            onChange={(e) => changeFilter(() => setTenantText(e.target.value))}
          />
          <datalist id={`${id}-orgs`}>
            {known.map((x) => (
              <option key={x.orgNumber} value={x.name} />
            ))}
          </datalist>
          {unknownTenant ? (
            <p id={`${id}-org-e`} className="op-error">
              {t('auditLog.unknownTenant')}
            </p>
          ) : null}
        </div>
        <div className="op-field">
          <label htmlFor={`${id}-kind`}>{t('auditLog.action')}</label>
          <select
            id={`${id}-kind`}
            className="op-input"
            value={action === 'all' ? '' : action}
            onChange={(e) =>
              changeFilter(() => setAction((e.target.value || 'all') as ActionFilter))
            }
          >
            {(Object.keys(actionFilters) as ActionFilter[]).map((k) => (
              <option key={k} value={k === 'all' ? '' : k}>
                {t(actionFilters[k].label)}
              </option>
            ))}
          </select>
        </div>
        <div className="op-field">
          <label htmlFor={`${id}-who`}>{t('auditLog.who')}</label>
          <select
            id={`${id}-who`}
            className="op-input"
            value={who === 'all' ? '' : who}
            onChange={(e) => changeFilter(() => setWho((e.target.value || 'all') as WhoFilter))}
          >
            <option value="">{t('auditLog.all')}</option>
            <option value="operator">{t('auditLog.whoDigdir')}</option>
            <option value="tenant">{t('auditLog.whoTenants')}</option>
          </select>
        </div>
        <fieldset className="op-period">
          <legend>{t('auditLog.period')}</legend>
          <div className="op-field">
            <label htmlFor={`${id}-from`} className="plain">
              {t('auditLog.from')}
            </label>
            <input
              id={`${id}-from`}
              className="op-input"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => changeFilter(() => setFrom(e.target.value))}
            />
          </div>
          <div className="op-field">
            <label htmlFor={`${id}-to`} className="plain">
              {t('auditLog.to')}
            </label>
            <input
              id={`${id}-to`}
              className="op-input"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => changeFilter(() => setTo(e.target.value))}
            />
          </div>
        </fieldset>
      </div>
      {state.status === 'error' ? (
        isMissing(state.error) ? (
          <p>{t('audit.unavailable')}</p>
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )
      ) : !page ? (
        <Loading label={t('auditLog.loading')} shape="table" onRetry={retry} />
      ) : (
        <>
          <p className="op-subtle" aria-live="polite" style={{ margin: 0 }}>
            {t('auditLog.count', { count: page.total })}
          </p>
          {page.data.length === 0 ? (
            <p>
              {t('auditLog.noMatch')}{' '}
              <button type="button" className="op-btn" onClick={reset}>
                {t('auditLog.reset')}
              </button>
            </p>
          ) : (
            <div
              tabIndex={0}
              role="region"
              aria-label={t('auditLog.title')}
              aria-busy={state.status === 'loading' || undefined}
              className="op-table-wrap"
            >
              <table className="op-table w860 top">
                <thead>
                  <tr>
                    <th scope="col" aria-sort="descending">
                      {t('auditLog.colTime')} <span aria-hidden="true">↓</span>
                    </th>
                    <th scope="col">{t('auditLog.who')}</th>
                    <th scope="col">{t('auditLog.tenant')}</th>
                    <th scope="col">{t('auditLog.action')}</th>
                    <th scope="col">{t('auditLog.colReason')}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.data.map((e) => (
                    <tr key={e.task}>
                      <td className="nowrap">{`${dayMonth(e.at, f)} ${clock(e.at, f)}`}</td>
                      <td className="nowrap">{whoOf(e)}</td>
                      <td>
                        {/\d{9}/.test(e.tenant) ? (
                          <a href={orgHref(e.tenant, 'log')}>{tenantOf(e)}</a>
                        ) : (
                          tenantOf(e)
                        )}
                      </td>
                      <td>
                        {handling(e)}
                        {e.outcome === 'rejected' ? (
                          <>
                            {' '}
                            <Chip tone="danger">{t('audit.rejected')}</Chip>
                          </>
                        ) : null}
                      </td>
                      <td>{e.reason || '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {page.data.length < page.total ? (
            <button
              type="button"
              className="op-btn"
              style={{ alignSelf: 'flex-start' }}
              aria-disabled={state.status === 'loading' || undefined}
              onClick={() => {
                if (state.status !== 'loading') setLimit((n) => n + pageSize);
              }}
            >
              {t('auditLog.more')}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
};
