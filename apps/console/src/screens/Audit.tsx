import {
  Alert,
  Button,
  Checkbox,
  Label,
  Paragraph,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useRef, useState } from 'react';
import type { ApiClient } from '../api';
import { navigate, useAsync } from '../hooks';
import { useT, type PlainKey, type T } from '../i18n';
import { ErrorState, Loading } from '../states';
import { useSupport } from '../support';
import { tenantLabel, useTenantNames } from '../tenant-names';
import type { AuditEntry } from '../types';
import { Flash, formatWhen, isMissing, PageHeader, TableRegion, useFlash } from '../ui';

export const actionKey: Record<string, PlainKey> = {
  'platform.service.publish': 'audit.actionServicePublish',
  'platform.service.share': 'audit.actionServiceShare',
  'platform.setting.set': 'audit.actionSettingSet',
  'platform.setting.pin': 'audit.actionSettingPin',
  'platform.default.set': 'audit.actionDefaultSet',
  'platform.tenant.import': 'audit.actionTenantImport',
  'platform.tenant.create': 'audit.actionTenantCreate',
  'platform.support.open': 'audit.actionSupportOpen',
  'platform.support.end': 'audit.actionSupportEnd',
  'platform.support.extend': 'audit.actionSupportExtend',
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
  'platform.platform-secret.set': 'audit.actionPlatformSecretSet',
  'platform.plugin.register': 'audit.actionPluginRegister',
  'platform.plugin.remove': 'audit.actionPluginRemove',
  'platform.plugin.verify': 'audit.actionPluginVerify',
  'platform.plugin.promote': 'audit.actionPluginPromote',
  'platform.hook.feedback': 'audit.actionHookFeedback',
  'platform.private-networks.save': 'audit.actionPrivateNetworksSave',
  'platform.service.lifecycle': 'audit.actionServiceLifecycle',
  'platform.skill.share.decide': 'audit.actionSkillShareDecide',
  'platform.recipe.share': 'audit.actionRecipeShare',
  'platform.recipe.unshare': 'audit.actionRecipeUnshare',
  'platform.trigger.pause': 'audit.actionTriggerPause',
};

type Period = 'day' | 'week' | 'month';

const labelOf = (e: AuditEntry, t: T) => {
  const key = actionKey[e.action];
  return e.actionLabel ?? (key ? t(key) : t('audit.otherAction'));
};
const targetOf = (e: AuditEntry) => {
  if (!e.target || e.target === e.action) return '–';
  const found = /^(service|model|setting|pin|default|tenant|support):(.+)$/.exec(e.target);
  if (!found?.[1] || !found[2]) return e.target;
  if (found[1] === 'support') return '–';
  if (found[1] === 'service') return found[2].split('/').pop() ?? found[2];
  return found[1] === 'default' ? found[2].replace(/@\d+$/, '') : found[2];
};

const definitionTarget = (e: AuditEntry) => {
  const found = /^(Service|StepFlow):(.+)@(\d+)$/.exec(e.target);
  return found && found[2] && found[3]
    ? {
        kind: found[1] === 'StepFlow' ? 'step-flow' : 'service',
        id: found[2],
        version: found[3],
      }
    : undefined;
};

const targetTextOf = (e: AuditEntry, t: T) => {
  const found = definitionTarget(e);
  return found
    ? `${found.id} (${t('audit.targetVersion', { version: found.version })})`
    : targetOf(e);
};

const Target = ({ entry, t }: { entry: AuditEntry; t: T }) => {
  const found = definitionTarget(entry);
  if (!found) return <>{targetOf(entry)}</>;
  return (
    <>
      <Button
        variant="tertiary"
        data-size="sm"
        onClick={() =>
          navigate('/tenants/services', { tenant: entry.tenant, kind: found.kind, id: found.id })
        }
      >
        {found.id}
      </Button>{' '}
      <span className="meta">{t('audit.targetVersion', { version: found.version })}</span>
    </>
  );
};

const describe = (name: (orgNumber: string) => string, t: T) => {
  const tenantOf = (e: AuditEntry) =>
    e.tenantName === 'Alle' || e.tenant === 'alle'
      ? t('common.allTenants')
      : tenantLabel(e.tenant, e.tenantName ?? name(e.tenant), t);
  const orgOf = (e: AuditEntry) =>
    e.actorOrg ?? (e.actor.startsWith('operator:') ? 'Digdir' : tenantOf(e));
  const personOf = (e: AuditEntry) => e.actorName ?? t('audit.personIn', { org: orgOf(e) });
  return { tenantOf, orgOf, personOf };
};

const Log = ({
  api,
  entries,
  scoped,
}: {
  api: ApiClient;
  entries: AuditEntry[];
  scoped?: string;
}) => {
  const t = useT();
  const f = useFormat();
  const tRef = useRef(t);
  tRef.current = t;
  const { tenantOf, orgOf, personOf } = describe(useTenantNames(api), t);
  const [tenant, setTenant] = useState('all');
  const [person, setPerson] = useState('');
  const [action, setAction] = useState('all');
  const [period, setPeriod] = useState<Period>('month');
  const [onlyDigdir, setOnlyDigdir] = useState(false);
  const flash = useFlash();
  const now = Date.now();
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const since = startOfToday - { day: 0, week: 6, month: 29 }[period] * 86400000;
  const p = person.trim().toLowerCase();
  const rows = [...entries]
    .filter(
      (e) =>
        (tenant === 'all' || tenantOf(e) === tenant) &&
        (!p || personOf(e).toLowerCase().includes(p)) &&
        (action === 'all' || labelOf(e, t) === action) &&
        (!onlyDigdir || orgOf(e) === 'Digdir') &&
        new Date(e.at).getTime() >= since,
    )
    .sort((a, b) => b.at.localeCompare(a.at));
  const tenants = [...new Set(entries.map(tenantOf))];
  const actions = [...new Set(entries.map((e) => labelOf(e, t)))];
  const reset = () => {
    setTenant('all');
    setPerson('');
    setAction('all');
    setPeriod('month');
    setOnlyDigdir(false);
  };
  const exportCsv = async () => {
    const csv = [
      t('audit.csvHeader'),
      ...rows.map((e) =>
        [e.at, personOf(e), orgOf(e), tenantOf(e), labelOf(e, t), targetTextOf(e, t), e.reason]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(';'),
      ),
    ].join('\n');
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
      a.download = t('audit.csvFile');
      a.click();
    } catch {
      flash.show(t('audit.downloadFailed'), 'danger');
      return;
    }
    await api.logAuditExport(rows.length).catch(() => undefined);
    flash.show(tRef.current('audit.downloaded'));
  };
  return (
    <div className="stack">
      <Flash message={flash.message} />
      <div className="filters">
        {scoped ? null : (
          <div className="field">
            <Label htmlFor="r-virk">{t('audit.tenant')}</Label>
            <Select id="r-virk" value={tenant} onChange={(e) => setTenant(e.target.value)}>
              <Select.Option value="all">{t('common.allTenants')}</Select.Option>
              {tenants.map((name) => (
                <Select.Option key={name} value={name}>
                  {name}
                </Select.Option>
              ))}
            </Select>
          </div>
        )}
        <Textfield
          id="r-person"
          label={t('audit.person')}
          type="search"
          value={person}
          onChange={(e) => setPerson(e.target.value)}
        />
        <div className="field">
          <Label htmlFor="r-handling">{t('audit.action')}</Label>
          <Select id="r-handling" value={action} onChange={(e) => setAction(e.target.value)}>
            <Select.Option value="all">{t('audit.allActions')}</Select.Option>
            {actions.map((a) => (
              <Select.Option key={a} value={a}>
                {a}
              </Select.Option>
            ))}
          </Select>
        </div>
        <div className="field">
          <Label htmlFor="r-tid">{t('audit.period')}</Label>
          <Select id="r-tid" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            <Select.Option value="day">{t('audit.today')}</Select.Option>
            <Select.Option value="week">{t('audit.last7')}</Select.Option>
            <Select.Option value="month">{t('audit.last30')}</Select.Option>
          </Select>
        </div>
        <Checkbox
          label={t('audit.onlyDigdir')}
          checked={onlyDigdir}
          onChange={() => setOnlyDigdir((v) => !v)}
        />
      </div>
      <div className="card-head">
        <span aria-live="polite" className="meta">
          {t('audit.events', { count: rows.length })}
        </span>
        <Button variant="secondary" data-size="sm" onClick={() => void exportCsv()}>
          {t('audit.exportCsv')}
        </Button>
      </div>
      {rows.length === 0 ? (
        <Paragraph>
          {t('audit.noMatch')}{' '}
          <Button variant="tertiary" data-size="sm" onClick={reset}>
            {t('audit.resetFilter')}
          </Button>
        </Paragraph>
      ) : (
        <TableRegion label={t('audit.tableLabel')}>
          <Table className="wide-900">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('audit.colTime')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('audit.person')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('audit.tenant')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('audit.action')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('audit.colTarget')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('common.reason')}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((e) => {
                const digdir = orgOf(e) === 'Digdir';
                return (
                  <TableRow key={e.task} className={digdir ? 'digdir-row' : undefined}>
                    <TableCell className="sm nowrap">{formatWhen(e.at, f, t)}</TableCell>
                    <TableCell>
                      <span className="two-line">
                        <span className="label-strong">{personOf(e)}</span>
                        <Tag data-size="sm" data-color={digdir ? 'info' : 'neutral'}>
                          {orgOf(e)}
                        </Tag>
                      </span>
                    </TableCell>
                    <TableCell>{tenantOf(e)}</TableCell>
                    <TableCell>
                      {labelOf(e, t)}
                      {e.outcome === 'rejected' ? (
                        <>
                          {' '}
                          <Tag data-size="sm" data-color="danger">
                            {t('audit.rejected')}
                          </Tag>
                        </>
                      ) : null}
                    </TableCell>
                    <TableCell className="sm">
                      <Target entry={e} t={t} />
                    </TableCell>
                    <TableCell className="sm">{e.reason || '–'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableRegion>
      )}
    </div>
  );
};

export const Audit = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const support = useSupport();
  const session = support.session;
  const [state, retry] = useAsync(
    async (signal) => {
      try {
        return { entries: await api.operatorAudit(signal), scoped: undefined };
      } catch (error) {
        if (!isMissing(error) || !session) throw error;
        return {
          entries: await api.audit(session.tenant, session.id, signal),
          scoped: session.tenantName,
        };
      }
    },
    [api, session?.id],
  );
  return (
    <>
      <PageHeader title={t('audit.title')} intro={t('audit.intro')} />
      {state.status === 'loading' ? (
        <Loading label={t('audit.loading')} />
      ) : state.status === 'error' ? (
        isMissing(state.error) ? (
          <Alert data-color="info">
            <Paragraph>{t('audit.unavailable')}</Paragraph>
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() => (window.location.hash = '/support-access')}
            >
              {t('audit.startSupport')}
            </Button>
          </Alert>
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )
      ) : (
        <>
          {state.data.scoped ? (
            <Alert data-color="info" data-size="sm">
              {t('audit.scoped', { tenant: state.data.scoped })}
            </Alert>
          ) : null}
          <Log
            api={api}
            entries={state.data.entries}
            {...(state.data.scoped ? { scoped: state.data.scoped } : {})}
          />
        </>
      )}
    </>
  );
};
