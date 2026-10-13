import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Fieldset,
  FieldsetLegend,
  Heading,
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
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api';
import { useAsync } from '../hooks';
import { useT, type PlainKey } from '../i18n';
import { ErrorState, Loading } from '../states';
import type { ImportPlanItem, SettingsGrid } from '../types';
import { TableRegion } from '../ui';
import { reasonProblem } from '../reason';

type Mode = 'export' | 'import' | 'clone';
type Policy = 'skip' | 'overwrite';

interface Bundle {
  format?: string;
  tenant?: string;
  definitions?: { definition: { kind?: string; metadata: { id: string } } }[];
  settings?: { values: Record<string, unknown>; pins?: Record<string, number> };
  [key: string]: unknown;
}

const actionKey: Record<string, PlainKey> = {
  create: 'transfer.actionCreate',
  update: 'transfer.actionUpdate',
  unchanged: 'transfer.actionUnchanged',
  skip: 'transfer.actionSkip',
};

const outcomeOf = (action: string): 'create' | 'change' | 'skip' | undefined =>
  action === 'create'
    ? 'create'
    : action === 'update'
      ? 'change'
      : action === 'unchanged' || action === 'skip'
        ? 'skip'
        : undefined;

const describe = (target: string, grid: SettingsGrid | undefined) => {
  const service = /^Service:[^/]+\/(.+)$/.exec(target);
  if (service) return { where: 'service' as const, label: service[1] ?? target };
  const setting = /^setting:(.+)$/.exec(target);
  if (setting) {
    const key = setting[1] ?? '';
    return {
      where: 'tenant' as const,
      label: grid?.settings.find((s) => s.key === key)?.label ?? key,
    };
  }
  return { where: 'none' as const, label: target };
};

const pick = (
  bundle: Bundle,
  include: { settings: boolean; services: boolean },
  tenant: string,
): Bundle => ({
  ...bundle,
  tenant,
  definitions: include.services ? (bundle.definitions ?? []) : [],
  settings: include.settings
    ? (bundle.settings ?? { values: {}, pins: {} })
    : { values: {}, pins: {} },
});

const without = (bundle: Bundle, skipped: string[]): Bundle => ({
  ...bundle,
  definitions: (bundle.definitions ?? []).filter(
    (d) =>
      !skipped.some((t) => t.endsWith(`/${d.definition.metadata.id}`) && t.startsWith('Service:')),
  ),
  settings: {
    values: Object.fromEntries(
      Object.entries(bundle.settings?.values ?? {}).filter(
        ([k]) => !skipped.includes(`setting:${k}`),
      ),
    ),
    pins: bundle.settings?.pins ?? {},
  },
});

export const Transfer = ({
  api,
  grid,
  onFlash,
}: {
  api: ApiClient;
  grid: SettingsGrid | undefined;
  onFlash: (text: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [tenants, retry] = useAsync((signal) => api.listTenants(signal), [api]);
  const [mode, setMode] = useState<Mode>('export');
  const [step, setStep] = useState(1);
  const [tenant, setTenant] = useState('');
  const [from, setFrom] = useState('');
  const [include, setInclude] = useState({ settings: true, services: true });
  const [file, setFile] = useState<{ name: string; bundle?: Bundle; error?: string } | undefined>();
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  const [bundle, setBundle] = useState<Bundle | undefined>();
  const [plan, setPlan] = useState<ImportPlanItem[]>([]);
  const [session, setSession] = useState<string | undefined>();
  const [policy, setPolicy] = useState<Policy>('skip');
  const [perRow, setPerRow] = useState<Record<string, Policy>>({});
  const [done, setDone] = useState<string | undefined>();

  const heldSession = useRef<string | undefined>(undefined);
  heldSession.current = session;
  useEffect(
    () => () => {
      if (heldSession.current)
        void api
          .endSupportSession(heldSession.current, tRef.current('support.endedEarlyReason'))
          .catch(() => undefined);
    },
    [api],
  );

  if (tenants.status === 'loading') return <Loading label={t('transfer.loadingTenants')} />;
  if (tenants.status === 'error') return <ErrorState error={tenants.error} onRetry={retry} />;
  const list = tenants.data.filter((x) => x.status !== 'onboarding' || mode !== 'export');
  const target = tenant || list[0]?.orgNumber || '';
  const source = from || list[0]?.orgNumber || '';
  const nameOf = (org: string) => tenants.data.find((x) => x.orgNumber === org)?.name ?? org;
  const steps =
    mode === 'export'
      ? [t('transfer.stepChoose'), t('transfer.stepReview')]
      : [t('transfer.stepChoose'), t('transfer.stepDryRun'), t('transfer.stepDone')];

  const endSession = (id: string | undefined) => {
    if (id)
      void api
        .endSupportSession(id, tRef.current('support.endedEarlyReason'))
        .catch(() => undefined);
  };

  const reset = (next: Mode = mode) => {
    endSession(session);
    setSession(undefined);
    setMode(next);
    setStep(1);
    setErrors({});
    setFailed(undefined);
    setPlan([]);
    setPerRow({});
    setBundle(undefined);
    setDone(undefined);
  };

  const decision = (item: ImportPlanItem) => perRow[item.target] ?? policy;
  const rows = plan.map((item) => {
    const d = describe(item.target, grid);
    const outcome = item.conflict
      ? decision(item) === 'overwrite'
        ? 'change'
        : 'skip'
      : outcomeOf(item.action);
    const key = actionKey[item.action];
    const action = item.conflict
      ? t(decision(item) === 'overwrite' ? 'transfer.conflictOverwrite' : 'transfer.conflictSkip')
      : key
        ? t(key)
        : item.action;
    return { item, ...d, action, outcome };
  });
  const counts = {
    create: rows.filter((r) => r.outcome === 'create').length,
    change: rows.filter((r) => r.outcome === 'change').length,
    skip: rows.filter((r) => r.outcome === 'skip').length,
    conflict: rows.filter((r) => r.item.conflict).length,
  };

  const next = async () => {
    const problems: Record<string, string> = {};
    if (!include.settings && !include.services) problems.items = t('transfer.pickSomething');
    if (mode === 'import' && (!file?.bundle || file.error))
      problems.file = file?.error ?? t('transfer.pickFile');
    if (mode === 'clone' && source === target) problems.same = t('transfer.pickTwo');
    const reasonError = reasonProblem(t, reason);
    if (reasonError) problems.reason = reasonError;
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setBusy(true);
    setFailed(undefined);
    try {
      if (mode === 'export') {
        const opened = await api.openSupportSession(
          target,
          t('transfer.exportReason', { reason: reason.trim() }),
          15,
        );
        try {
          setBundle(pick((await api.exportTenant(target, opened.id)) as Bundle, include, target));
        } finally {
          endSession(opened.id);
        }
        setStep(2);
        return;
      }
      let incoming = file?.bundle;
      if (mode === 'clone') {
        const read = await api.openSupportSession(
          source,
          t('transfer.cloneReadReason', { name: nameOf(target), reason: reason.trim() }),
          15,
        );
        try {
          incoming = (await api.exportTenant(source, read.id)) as Bundle;
        } finally {
          endSession(read.id);
        }
      }
      const write = await api.openSupportSession(
        target,
        t(mode === 'clone' ? 'transfer.cloneReason' : 'transfer.importReason', {
          reason: reason.trim(),
        }),
        15,
      );
      const picked = pick(incoming ?? {}, include, target);
      const result = await api.importTenant(target, picked, {
        dryRun: true,
        reason: reason.trim(),
        session: write.id,
      });
      setBundle(picked);
      setSession(write.id);
      setPlan(result.plan);
      setStep(2);
    } catch {
      setFailed(tRef.current('transfer.readFailed'));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!bundle || !session) return;
    setBusy(true);
    setFailed(undefined);
    try {
      const skipped = plan.filter((p) => p.conflict && decision(p) === 'skip').map((p) => p.target);
      await api.importTenant(target, without(bundle, skipped), {
        dryRun: false,
        reason: reason.trim(),
        session,
      });
      endSession(session);
      setSession(undefined);
      setDone(
        mode === 'clone'
          ? tRef.current('transfer.cloned', { name: nameOf(target) })
          : tRef.current('transfer.imported'),
      );
      setStep(3);
    } catch {
      setFailed(tRef.current('transfer.applyFailed'));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    const name = t('transfer.fileName', {
      name: nameOf(target).toLowerCase().replace(/\s+/g, '-'),
      date: new Date().toISOString().slice(0, 10),
    });
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      );
      a.download = name;
      a.click();
    } catch {
      return onFlash(t('transfer.downloadFailed'));
    }
    onFlash(t('transfer.downloaded'));
  };

  const settingCount = Object.keys(bundle?.settings?.values ?? {}).length;
  const serviceCount = bundle?.definitions?.length ?? 0;

  return (
    <div className="stack">
      <Fieldset>
        <FieldsetLegend>{t('transfer.whatToDo')}</FieldsetLegend>
        <div className="chips">
          {(
            [
              ['export', 'transfer.modeExport'],
              ['import', 'transfer.modeImport'],
              ['clone', 'transfer.modeClone'],
            ] as const
          ).map(([value, label]) => (
            <Chip.Radio
              key={value}
              name="xmode"
              checked={mode === value}
              onChange={() => reset(value)}
            >
              {t(label)}
            </Chip.Radio>
          ))}
        </div>
      </Fieldset>
      <ol className="stepper" aria-label={t('transfer.stepsLabel')}>
        {steps.map((label, i) => (
          <li
            key={label}
            aria-current={step === i + 1 ? 'step' : undefined}
            className={step > i + 1 ? 'done' : step === i + 1 ? 'current' : undefined}
          >
            <span aria-hidden="true">{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <Alert data-color="info" data-size="sm">
        {t('transfer.secretsNote')}
      </Alert>
      {failed ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          {failed}
        </Alert>
      ) : null}

      {step === 1 ? (
        <div className="card stack">
          {mode === 'clone' ? (
            <div className="toolbar">
              <div className="field">
                <Label htmlFor="fra">{t('transfer.copyFrom')}</Label>
                <Select id="fra" value={source} onChange={(e) => setFrom(e.target.value)}>
                  {list.map((x) => (
                    <Select.Option key={x.orgNumber} value={x.orgNumber}>
                      {x.name}
                    </Select.Option>
                  ))}
                </Select>
              </div>
              <div className="field">
                <Label htmlFor="til">{t('transfer.copyTo')}</Label>
                <Select id="til" value={target} onChange={(e) => setTenant(e.target.value)}>
                  {list.map((x) => (
                    <Select.Option key={x.orgNumber} value={x.orgNumber}>
                      {x.name}
                    </Select.Option>
                  ))}
                </Select>
              </div>
            </div>
          ) : (
            <div className="field narrow">
              <Label htmlFor="x-tenant">{t('transfer.tenant')}</Label>
              <Select id="x-tenant" value={target} onChange={(e) => setTenant(e.target.value)}>
                {list.map((x) => (
                  <Select.Option key={x.orgNumber} value={x.orgNumber}>
                    {x.name}
                  </Select.Option>
                ))}
              </Select>
            </div>
          )}
          {errors.same ? <ValidationMessage>{errors.same}</ValidationMessage> : null}
          {mode === 'import' ? (
            <div className="field">
              <Label htmlFor="imp">{t('transfer.configFile')}</Label>
              <input
                id="imp"
                type="file"
                accept=".json,application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  void f.text().then(
                    (text) => {
                      try {
                        setFile({ name: f.name, bundle: JSON.parse(text) as Bundle });
                      } catch {
                        setFile({
                          name: f.name,
                          error: tRef.current('transfer.notExportFile'),
                        });
                      }
                    },
                    () => setFile({ name: f.name, error: tRef.current('transfer.unreadable') }),
                  );
                }}
              />
              {file ? (
                <Tag data-size="sm" data-color={file.error ? 'danger' : 'success'}>
                  {file.name}
                </Tag>
              ) : null}
              {errors.file ? <ValidationMessage>{errors.file}</ValidationMessage> : null}
            </div>
          ) : null}
          <Fieldset>
            <FieldsetLegend>{t('transfer.include')}</FieldsetLegend>
            <Checkbox
              label={t('transfer.includeSettings')}
              description={t('transfer.includeSettingsHelp')}
              checked={include.settings}
              onChange={() => setInclude((i) => ({ ...i, settings: !i.settings }))}
            />
            <Checkbox
              label={t('transfer.includeServices')}
              description={t('transfer.includeServicesHelp')}
              checked={include.services}
              onChange={() => setInclude((i) => ({ ...i, services: !i.services }))}
            />
          </Fieldset>
          {errors.items ? <ValidationMessage>{errors.items}</ValidationMessage> : null}
          <div className="field">
            <Label htmlFor="x-grunn">{t('common.reason')}</Label>
            <Paragraph data-size="sm" className="meta">
              {t('transfer.reasonHelp')}
            </Paragraph>
            <Textarea
              id="x-grunn"
              rows={2}
              value={reason}
              aria-invalid={errors.reason ? true : undefined}
              onChange={(e) => setReason(e.target.value)}
            />
            {errors.reason ? <ValidationMessage>{errors.reason}</ValidationMessage> : null}
          </div>
        </div>
      ) : null}

      {step === 2 && mode === 'export' && bundle ? (
        <div className="stack">
          <div className="name-line">
            <span className="label-strong">{nameOf(target)}</span>
            <span className="meta">
              {t('transfer.summary', { settings: settingCount, services: serviceCount })}
            </span>
          </div>
          <pre className="code" tabIndex={0} aria-label={t('transfer.fileContents')}>
            <code>{JSON.stringify(bundle, null, 2)}</code>
          </pre>
        </div>
      ) : null}

      {step === 2 && mode !== 'export' ? (
        <div className="stack">
          <Heading level={2} data-size="xs">
            {t('transfer.dryRunTitle')}
          </Heading>
          <ul className="plain name-line" aria-label={t('transfer.summaryLabel')}>
            <li>
              <Tag data-color="success">{t('transfer.countCreate', { count: counts.create })}</Tag>
            </li>
            <li>
              <Tag data-color="info">{t('transfer.countChange', { count: counts.change })}</Tag>
            </li>
            <li>
              <Tag data-color="neutral">{t('transfer.countSkip', { count: counts.skip })}</Tag>
            </li>
            <li>
              <Tag data-color="warning">
                {t('transfer.countConflict', { count: counts.conflict })}
              </Tag>
            </li>
          </ul>
          <Fieldset>
            <FieldsetLegend>{t('transfer.onConflictAll')}</FieldsetLegend>
            <div className="chips">
              {(
                [
                  ['skip', 'transfer.skip'],
                  ['overwrite', 'transfer.overwrite'],
                ] as const
              ).map(([value, label]) => (
                <Chip.Radio
                  key={value}
                  name="glob"
                  checked={policy === value}
                  onChange={() => {
                    setPolicy(value);
                    setPerRow({});
                  }}
                >
                  {t(label)}
                </Chip.Radio>
              ))}
            </div>
          </Fieldset>
          <TableRegion label={t('transfer.changesLabel')}>
            <Table data-size="sm">
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('transfer.colWhere')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('transfer.colSetting')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('transfer.colResult')}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow
                    key={r.item.target}
                    className={r.item.conflict ? 'conflict' : undefined}
                  >
                    <TableCell>
                      {r.where === 'tenant'
                        ? nameOf(target)
                        : r.where === 'service'
                          ? t('transfer.whereService')
                          : '–'}
                    </TableCell>
                    <TableHeaderCell scope="row" className="row-head">
                      {r.label}
                    </TableHeaderCell>
                    <TableCell>
                      <span className="two-line">
                        <Tag
                          data-size="sm"
                          data-color={
                            r.item.conflict
                              ? 'warning'
                              : r.item.action === 'update'
                                ? 'info'
                                : r.item.action === 'create'
                                  ? 'success'
                                  : 'neutral'
                          }
                        >
                          {r.action}
                        </Tag>
                        {r.item.conflict ? (
                          <>
                            <span className="meta">{t('transfer.conflictNote')}</span>
                            <span
                              role="radiogroup"
                              aria-label={t('transfer.onConflictFor', { label: r.label })}
                              className="chips"
                            >
                              {(
                                [
                                  ['skip', 'transfer.skip'],
                                  ['overwrite', 'transfer.overwrite'],
                                ] as const
                              ).map(([value, label]) => (
                                <Chip.Radio
                                  key={value}
                                  data-size="sm"
                                  name={`k${i}`}
                                  checked={decision(r.item) === value}
                                  onChange={() =>
                                    setPerRow((p) => ({ ...p, [r.item.target]: value }))
                                  }
                                >
                                  {t(label)}
                                </Chip.Radio>
                              ))}
                            </span>
                          </>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableRegion>
        </div>
      ) : null}

      {step === 3 && done ? (
        <Alert data-color="success">
          <Heading level={2} data-size="2xs">
            {done}
          </Heading>
          <Paragraph>
            {t('transfer.doneSummary', {
              create: counts.create,
              change: counts.change,
              skip: counts.skip,
            })}
          </Paragraph>
        </Alert>
      ) : null}

      <div className="actions-row">
        {step === 2 ? (
          <Button
            variant="secondary"
            onClick={() => {
              endSession(session);
              setSession(undefined);
              setStep(1);
            }}
          >
            {t('transfer.previous')}
          </Button>
        ) : null}
        {step === 1 ? (
          <Button loading={busy} onClick={() => void next()}>
            {mode === 'export' ? t('transfer.next') : t('transfer.runDry')}
          </Button>
        ) : null}
        {step === 2 ? (
          <Button loading={busy} onClick={() => (mode === 'export' ? download() : void apply())}>
            {mode === 'export' ? t('transfer.download') : t('transfer.apply')}
          </Button>
        ) : null}
        {step === 3 ? (
          <Button variant="secondary" onClick={() => reset()}>
            {t('transfer.restart')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
