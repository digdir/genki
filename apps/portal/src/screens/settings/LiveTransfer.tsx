import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
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
import { useId, useRef, useState } from 'react';
import { ApiError, type ApiClient, type ImportPlan, type TenantBundle } from '../../api';
import { useAsync } from '../../hooks';
import { needsRight, useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { slug } from '../../data/settings';
import { reasonProblem } from '../../components/ReasonField';
import { useT, type PlainKey, type T } from '../../i18n';

type Mode = 'export' | 'import';
type Policy = 'skip' | 'overwrite';

const today = () => new Date().toISOString().slice(0, 10);

const actionKeys: Record<string, PlainKey> = {
  create: 'settings.actCreated',
  update: 'settings.actChanged',
  unchanged: 'settings.actUnchanged',
  skip: 'settings.actSkipped',
};

const describeTarget = (target: string, t: T) => {
  const definition = /^(Service|StepFlow):[^/]+\/(.+)$/.exec(target);
  if (definition)
    return {
      where:
        definition[1] === 'Service' ? t('settings.liveWhereService') : t('settings.liveWhereFlow'),
      label: definition[2] ?? target,
    };
  const setting = /^setting:(.+)$/.exec(target);
  if (setting) return { where: t('settings.liveWhereSetting'), label: setting[1] ?? target };
  const pin = /^pin:(.+)$/.exec(target);
  if (pin) return { where: t('settings.liveWherePin'), label: pin[1] ?? target };
  return { where: '–', label: target };
};

const pick = (bundle: TenantBundle, include: { definitions: boolean; settings: boolean }) => ({
  ...bundle,
  definitions: include.definitions ? (bundle.definitions ?? []) : [],
  settings: include.settings
    ? { values: bundle.settings?.values ?? {}, pins: bundle.settings?.pins ?? {} }
    : { values: {}, pins: {} },
});

const download = (name: string, text: string) => {
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    a.click();
    return true;
  } catch {
    return false;
  }
};

const problemText = (error: unknown, t: T) =>
  error instanceof ApiError && error.problem?.errors?.length
    ? error.problem.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
    : t('settings.liveNoAnswer');

const Include = ({
  bundle,
  include,
  onChange,
}: {
  bundle: TenantBundle;
  include: { definitions: boolean; settings: boolean };
  onChange: (next: { definitions: boolean; settings: boolean }) => void;
}) => {
  const t = useT();
  const definitions = bundle.definitions ?? [];
  const settings = Object.keys(bundle.settings?.values ?? {}).length;
  return (
    <Fieldset>
      <Fieldset.Legend>{t('settings.include')}</Fieldset.Legend>
      <div className="include-list">
        <Checkbox
          className="top"
          label={t('settings.liveServicesAndFlows')}
          description={
            definitions.length
              ? definitions
                  .map((d) => d.definition.metadata.name ?? d.definition.metadata.id)
                  .join(', ')
              : t('settings.pvNone')
          }
          checked={include.definitions}
          onChange={() => onChange({ ...include, definitions: !include.definitions })}
        />
        <Checkbox
          className="top"
          label={t('settings.liveSettings')}
          description={t('settings.liveSettingsDesc', { count: settings })}
          checked={include.settings}
          onChange={() => onChange({ ...include, settings: !include.settings })}
        />
      </div>
    </Fieldset>
  );
};

const Export = ({
  api,
  tenant,
  tenantName,
  onFlash,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  onFlash: (text: string) => void;
}) => {
  const t = useT();
  const canExport = useRights().has('manage-services');
  const [state, retry] = useAsync(
    async (signal) => (canExport ? api.exportTenant(tenant, signal) : undefined),
    [api, tenant, canExport],
  );
  const [include, setInclude] = useState({ definitions: true, settings: true });
  const [error, setError] = useState('');
  if (state.status === 'loading') return <Loading label={t('settings.liveLoadingExport')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  if (!state.data) return <Paragraph data-size="sm">{needsRight('manage-services', t)}</Paragraph>;
  const bundle = pick(state.data, include);
  const fileName = `${slug(tenantName) || tenant}-eksport-${today()}.json`;
  const text = JSON.stringify(bundle, null, 2);
  return (
    <div className="stack-sm">
      <Include bundle={state.data} include={include} onChange={setInclude} />
      <div className="export-file">
        <div className="export-file-head">
          <span className="strong">{fileName}</span>
          <span>
            {t('settings.liveDefinitionsCount', {
              definitions: bundle.definitions.length,
              settings: Object.keys(bundle.settings.values).length,
            })}
          </span>
        </div>
        <pre tabIndex={0} aria-label={t('settings.exportContent')}>
          <code>{text}</code>
        </pre>
      </div>
      {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      <div className="actions transfer-actions">
        <Button
          variant="primary"
          onClick={() => {
            if (!include.definitions && !include.settings) {
              setError(t('settings.includeNothing'));
              return;
            }
            setError('');
            onFlash(
              download(fileName, text)
                ? t('settings.liveDownloaded')
                : t('settings.liveFileFailed'),
            );
          }}
        >
          {t('settings.nextDownload')}
        </Button>
      </div>
    </div>
  );
};

const Import = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const ids = { file: useId(), reason: useId() };
  const [file, setFile] = useState<{ name: string; bundle?: TenantBundle; error?: string }>();
  const [include, setInclude] = useState({ definitions: true, settings: true });
  const [policy, setPolicy] = useState<Policy>('skip');
  const [plan, setPlan] = useState<ImportPlan>();
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState('');
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ImportPlan>();

  const body = () => (file?.bundle ? { ...pick(file.bundle, include), tenant } : undefined);

  const dryRun = async (next: Policy = policy) => {
    const bundle = body();
    if (!bundle) {
      setFile((f) => ({ name: f?.name ?? '', error: t('settings.liveChooseExport') }));
      return;
    }
    setBusy(true);
    setFailed('');
    try {
      setPlan(
        await api.importTenant(tenant, bundle, {
          dryRun: true,
          onConflict: next,
          reason: t('settings.liveDryReason'),
        }),
      );
    } catch (error) {
      setFailed(problemText(error, tRef.current));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const bundle = body();
    if (!bundle) return;
    const reasonError = reasonProblem(reason, t);
    if (reasonError) {
      setReasonErr(reasonError);
      return;
    }
    setBusy(true);
    setFailed('');
    try {
      setDone(
        await api.importTenant(tenant, bundle, { dryRun: false, onConflict: policy, reason }),
      );
    } catch (error) {
      setFailed(problemText(error, tRef.current));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(undefined);
    setPlan(undefined);
    setDone(undefined);
    setReason('');
    setFailed('');
  };

  if (done) {
    const changed = done.plan.filter((p) => p.action === 'create' || p.action === 'update');
    return (
      <div className="stack-sm">
        <Alert data-color="success">
          <Heading level={2} data-size="2xs">
            {t('settings.importDone')}
          </Heading>
          <p className="no-margin">
            {t('settings.liveDoneText', {
              changed: changed.length,
              skipped: done.plan.length - changed.length,
            })}
          </p>
        </Alert>
        <div className="actions transfer-actions">
          <Button variant="secondary" onClick={reset}>
            {t('settings.restart')}
          </Button>
        </div>
      </div>
    );
  }

  const rows = (plan?.plan ?? []).map((item) => ({
    item,
    ...describeTarget(item.target, t),
    action: item.conflict
      ? t(policy === 'overwrite' ? 'settings.actConflictOverwrite' : 'settings.actConflictSkip')
      : actionKeys[item.action]
        ? t(actionKeys[item.action] as PlainKey)
        : item.action,
  }));

  return (
    <div className="stack-sm">
      <Field>
        <Label htmlFor={ids.file}>{t('settings.liveFileJson')}</Label>
        <input
          id={ids.file}
          type="file"
          accept=".json,application/json"
          className="file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            setPlan(undefined);
            if (!f) return;
            void f.text().then((text) => {
              try {
                const bundle = JSON.parse(text) as TenantBundle;
                if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.definitions))
                  throw new Error('not a bundle');
                setFile({ name: f.name, bundle });
              } catch {
                setFile({ name: f.name, error: tRef.current('settings.liveNotBundle') });
              }
            });
          }}
        />
        {file?.name ? (
          <Tag
            data-size="sm"
            data-color={file.error ? 'danger' : 'success'}
            className="align-start"
          >
            {file.name}
          </Tag>
        ) : null}
        {file?.error ? <ValidationMessage>{file.error}</ValidationMessage> : null}
      </Field>
      {file?.bundle ? (
        <Include
          bundle={file.bundle}
          include={include}
          onChange={(next) => {
            setInclude(next);
            setPlan(undefined);
          }}
        />
      ) : null}
      {failed ? (
        <Alert data-color="danger" data-size="sm">
          {failed}
        </Alert>
      ) : null}
      {plan ? (
        <div className="stack-sm">
          <Heading level={2} data-size="xs">
            {t('settings.dryRunTitle')}
          </Heading>
          <Fieldset>
            <Fieldset.Legend>{t('settings.onConflict')}</Fieldset.Legend>
            <div className="tag-row">
              {(
                [
                  ['skip', t('settings.skip')],
                  ['overwrite', t('settings.overwrite')],
                ] as const
              ).map(([k, l]) => (
                <Chip.Radio
                  key={k}
                  name="live-conflict"
                  checked={policy === k}
                  onChange={() => {
                    setPolicy(k);
                    void dryRun(k);
                  }}
                >
                  {l}
                </Chip.Radio>
              ))}
            </div>
          </Fieldset>
          {rows.length === 0 ? (
            <p>{t('settings.liveNothing')}</p>
          ) : (
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label={t('settings.dryRegion')}
            >
              <Table data-size="sm" className="dry-table">
                <TableHead>
                  <TableRow>
                    <TableHeaderCell scope="col">{t('settings.colWhere')}</TableHeaderCell>
                    <TableHeaderCell scope="col">{t('settings.colWhat')}</TableHeaderCell>
                    <TableHeaderCell scope="col">{t('settings.colResult')}</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow
                      key={r.item.target}
                      className={r.item.conflict ? 'conflict' : undefined}
                    >
                      <TableCell>{r.where}</TableCell>
                      <TableHeaderCell scope="row" className="row-head-plain">
                        {r.label}
                      </TableHeaderCell>
                      <TableCell>
                        <Tag data-size="sm" data-color={r.item.conflict ? 'warning' : 'neutral'}>
                          {r.action}
                        </Tag>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <Field className="reason-field">
            <Label htmlFor={ids.reason}>{t('common.reason')}</Label>
            <Textarea
              id={ids.reason}
              rows={2}
              value={reason}
              aria-invalid={reasonErr ? true : undefined}
              onChange={(e) => {
                setReason(e.target.value);
                setReasonErr('');
              }}
            />
            {reasonErr ? <ValidationMessage>{reasonErr}</ValidationMessage> : null}
          </Field>
        </div>
      ) : null}
      <div className="actions transfer-actions">
        {plan ? (
          <Button variant="primary" loading={busy} onClick={() => !busy && void apply()}>
            {t('settings.nextApply')}
          </Button>
        ) : (
          <Button variant="primary" loading={busy} onClick={() => !busy && void dryRun()}>
            {t('settings.nextDryRun')}
          </Button>
        )}
      </div>
    </div>
  );
};

export const LiveTransfer = ({
  api,
  tenant,
  tenantName,
  onFlash,
}: {
  api: ApiClient;
  tenant: string;
  tenantName: string;
  onFlash: (text: string) => void;
}) => {
  const t = useT();
  const [mode, setMode] = useState<Mode>('export');
  return (
    <div className="transfer stack">
      <Fieldset>
        <Fieldset.Legend>{t('settings.transferWhat')}</Fieldset.Legend>
        <div className="tag-row">
          {(
            [
              ['export', t('settings.transferExport')],
              ['import', t('settings.transferImport')],
            ] as const
          ).map(([id, label]) => (
            <Chip.Radio
              key={id}
              name="live-transfer-mode"
              checked={mode === id}
              onChange={() => setMode(id)}
            >
              {label}
            </Chip.Radio>
          ))}
        </div>
      </Fieldset>
      <Alert data-color="info" data-size="sm">
        {t('settings.liveInfo')}
      </Alert>
      {mode === 'export' ? (
        <Export api={api} tenant={tenant} tenantName={tenantName} onFlash={onFlash} />
      ) : (
        <Import api={api} tenant={tenant} />
      )}
    </div>
  );
};
