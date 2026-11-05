import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  FieldsetLegend,
  Heading,
  Label,
  Paragraph,
  Select,
  SelectOption,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useRef, useState } from 'react';
import { useAsync } from '../../hooks';
import { ApiError, type ApiClient } from '../../api';
import { useFormat } from '@genai/i18n/react';
import { useT, type PlainKey } from '../../i18n';
import { useTenantNames } from '../../tenant-names';
import type {
  Capability,
  ConfigEntry,
  EndpointProcessorRecord,
  ModelEndpointInput,
  ModelPrice,
  OperatorModel,
  Residency,
} from '../../types';
import {
  DialogError,
  inUseOf,
  InUseList,
  ReasonDialog,
  SidePanel,
  TableRegion,
  VisuallyHidden,
  type InUse,
} from '../../ui';
import { ProcessorRecordForm } from './ProcessorRecord';
import { reasonError, ReasonField } from './reason-field';

export const residencyLabel: Record<Residency, PlainKey> = {
  norway: 'endpoints.residencyNorway',
  eu: 'endpoints.residencyEu',
  global: 'endpoints.residencyGlobal',
};

export const capabilityLabel: Record<Capability, PlainKey> = {
  stream: 'endpoints.capStream',
  tools: 'endpoints.capTools',
  'json-schema': 'endpoints.capJsonSchema',
  reasoning: 'endpoints.capReasoning',
};

const secretPrefix = 'secret://platform/';

const problemText = (error: unknown, fallback: string) => {
  if (!(error instanceof ApiError)) return fallback;
  const details = (error.problem?.errors ?? []).map((e) => e.message).join('. ');
  return [error.problem?.title, details].filter(Boolean).join(': ') || fallback;
};

interface EndpointSpec {
  baseURL?: string;
  families?: Record<string, string>;
  auth?: { kind?: string; secret?: string; header?: string };
}

const specOf = (entry: ConfigEntry) => {
  const spec = entry.spec as EndpointSpec;
  return {
    families: Object.keys(spec.families ?? {}),
    baseURL: spec.baseURL,
    secret: spec.auth?.secret?.replace(secretPrefix, ''),
  };
};

interface FamilyRow {
  family: string;
  base: string;
}

const familyBasePattern = /^((\/[A-Za-z0-9._~-]+)*\/?|https:\/\/\S+)$/;

const EndpointForm = ({
  api,
  existing,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  existing?: ConfigEntry | undefined;
  onClose: () => void;
  onSaved: (id: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const spec = (existing?.spec ?? {}) as EndpointSpec;
  const storedSecret = spec.auth?.secret?.startsWith(secretPrefix)
    ? spec.auth.secret.slice(secretPrefix.length)
    : '';
  const [apis] = useAsync((signal) => api.modelApis(signal), [api]);
  const known =
    apis.status === 'ready' ? [...new Set(apis.data.map((a) => a.family))].sort() : undefined;
  const [id, setId] = useState(existing?.id ?? '');
  const [rows, setRows] = useState<FamilyRow[]>(
    spec.families
      ? Object.entries(spec.families).map(([family, base]) => ({ family, base }))
      : [{ family: 'openai', base: '' }],
  );
  const [baseURL, setBaseURL] = useState(spec.baseURL ?? '');
  const [authKind, setAuthKind] = useState<'api-key' | 'bearer'>(
    spec.auth?.kind === 'bearer' ? 'bearer' : 'api-key',
  );
  const [secretName, setSecretName] = useState(storedSecret);
  const [secretValue, setSecretValue] = useState('');
  const [secretSaved, setSecretSaved] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const familyOptions = (current: string) =>
    [...new Set([...(known ?? []), current, ...rows.map((r) => r.family)])].filter(Boolean).sort();
  const setRow = (index: number, change: Partial<FamilyRow>) =>
    setRows((all) => all.map((r, i) => (i === index ? { ...r, ...change } : r)));

  const check = (fields: string[]) => {
    const names = rows.map((r) => r.family);
    const all: Record<string, string | undefined> = {
      id: /^[a-z0-9][a-z0-9-]*$/.test(id) ? undefined : t('endpoints.idHint'),
      baseURL: /^https:\/\/\S+$/.test(baseURL) ? undefined : t('endpoints.urlHint'),
      families:
        rows.length === 0
          ? t('endpoints.familiesRequired')
          : names.some((n, i) => !n || names.indexOf(n) !== i)
            ? t('endpoints.familyHint')
            : rows.some((r) => !familyBasePattern.test(r.base.trim()))
              ? t('endpoints.familyBaseHint')
              : undefined,
      secretName: /^[a-z0-9][a-z0-9-]*$/.test(secretName)
        ? undefined
        : t('endpoints.secretNameHint'),
      secretValue: secretValue ? undefined : t('endpoints.secretValueHint'),
      reason: reasonError(reason, t),
    };
    const found = Object.fromEntries(
      fields.flatMap((f) => (all[f] ? [[f, all[f] as string]] : [])),
    );
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const saveSecret = async () => {
    setFailed(undefined);
    if (!check(['secretName', 'secretValue', 'reason'])) return;
    setBusy(true);
    try {
      await api.saveSecret(secretName, secretValue, reason.trim());
      setSecretValue('');
      setSecretSaved(secretName);
    } catch (error) {
      setFailed(problemText(error, tRef.current('endpoints.secretSaveFailed')));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setFailed(undefined);
    if (!check(['id', 'baseURL', 'families', 'secretName', 'reason'])) return;
    setBusy(true);
    const header = authKind === 'api-key' ? spec.auth?.header : undefined;
    const input: ModelEndpointInput = {
      baseURL,
      auth: {
        kind: authKind,
        secret: `${secretPrefix}${secretName}`,
        ...(header ? { header } : {}),
      },
      families: Object.fromEntries(rows.map((r) => [r.family, r.base.trim()])),
    };
    try {
      if (existing) await api.updateModelEndpoint(id, input, reason.trim());
      else await api.addModelEndpoint(id, input, reason.trim());
      onSaved(id);
    } catch (error) {
      setFailed(
        problemText(error, tRef.current(existing ? 'endpoints.saveFailed' : 'endpoints.addFailed')),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel labelledBy="endpoint-panel-h" onClose={onClose}>
      <div className="panel-head">
        <span className="eyebrow">{t('endpoints.panelEyebrow')}</span>
        <Heading level={2} data-size="xs" id="endpoint-panel-h" tabIndex={-1}>
          {existing
            ? t('endpoints.editEndpointTitle', { id: existing.id })
            : t('endpoints.addEndpointTitle')}
        </Heading>
      </div>
      <div className="panel-body">
        <Textfield
          label={t('endpoints.name')}
          description={t('endpoints.nameDescription')}
          value={id}
          readOnly={Boolean(existing)}
          onChange={(e) => setId(e.target.value.trim())}
          error={errors.id}
        />
        <Textfield
          label={t('endpoints.baseUrl')}
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value.trim())}
          error={errors.baseURL}
        />
        <Fieldset>
          <FieldsetLegend>{t('endpoints.families')}</FieldsetLegend>
          <Paragraph data-size="sm">{t('endpoints.familiesDescription')}</Paragraph>
          {rows.map((row, index) => (
            <div className="actions-row" key={index}>
              <div className="field">
                <Label htmlFor={`endpoint-family-${index}`}>{t('endpoints.familyName')}</Label>
                <Select
                  id={`endpoint-family-${index}`}
                  value={row.family}
                  onChange={(e) => setRow(index, { family: e.target.value })}
                >
                  {familyOptions(row.family).map((f) => (
                    <SelectOption key={f} value={f}>
                      {f}
                    </SelectOption>
                  ))}
                </Select>
              </div>
              <Textfield
                id={`endpoint-family-base-${index}`}
                label={t('endpoints.familyBase')}
                description={index === 0 ? t('endpoints.familyBaseDescription') : undefined}
                value={row.base}
                onChange={(e) => setRow(index, { base: e.target.value })}
              />
              <Button
                variant="tertiary"
                data-size="sm"
                aria-label={t('endpoints.removeFamily', { family: row.family })}
                disabled={rows.length === 1}
                onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
              >
                {t('endpoints.remove')}
              </Button>
            </div>
          ))}
          {errors.families ? <ValidationMessage>{errors.families}</ValidationMessage> : null}
          <div className="actions-row">
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() =>
                setRows((all) => [
                  ...all,
                  {
                    family: (known ?? []).find((f) => !all.some((r) => r.family === f)) ?? '',
                    base: '',
                  },
                ])
              }
            >
              {t('endpoints.addFamily')}
            </Button>
          </div>
        </Fieldset>
        <div className="field">
          <Label htmlFor="endpoint-auth">{t('endpoints.login')}</Label>
          <Select
            id="endpoint-auth"
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value as 'api-key' | 'bearer')}
          >
            <SelectOption value="api-key">{t('endpoints.apiKey')}</SelectOption>
            <SelectOption value="bearer">{t('endpoints.bearer')}</SelectOption>
          </Select>
        </div>
        <Fieldset>
          <FieldsetLegend>{t('endpoints.secret')}</FieldsetLegend>
          <Textfield
            label={t('endpoints.secretName')}
            description={t('endpoints.secretStoredAs', {
              name: `${secretPrefix}${secretName || `<${t('endpoints.secretNamePlaceholder')}>`}`,
            })}
            value={secretName}
            onChange={(e) => {
              setSecretName(e.target.value.trim());
              setSecretSaved(undefined);
            }}
            error={errors.secretName}
          />
          <Textfield
            label={t('endpoints.value')}
            description={t('endpoints.valueDescription')}
            type="password"
            autoComplete="off"
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            error={errors.secretValue}
          />
          <div className="actions-row">
            <Button
              variant="secondary"
              data-size="sm"
              loading={busy}
              onClick={() => void saveSecret()}
            >
              {t('endpoints.saveSecret')}
            </Button>
          </div>
          {secretSaved ? (
            <Alert data-color="success" data-size="sm" role="status">
              {t('endpoints.secretSaved', { name: secretSaved })}
            </Alert>
          ) : null}
        </Fieldset>
        <ReasonField value={reason} error={errors.reason} onChange={setReason} />
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {failed}
          </Alert>
        ) : null}
        <div className="actions-row">
          <Button loading={busy} onClick={() => void save()}>
            {existing ? t('endpoints.saveEndpoint') : t('endpoints.addEndpoint')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </SidePanel>
  );
};

export const ModelForm = ({
  api,
  endpoints,
  model,
  endpoint,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  endpoints: string[];
  model?: OperatorModel | undefined;
  endpoint?: string | undefined;
  onClose: () => void;
  onSaved: (model: OperatorModel) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [target, setTarget] = useState(model?.endpoint ?? endpoint ?? endpoints[0] ?? '');
  const [deployment, setDeployment] = useState(model?.deployment ?? '');
  const [family, setFamily] = useState(model?.family ?? '');
  const [residency, setResidency] = useState<Residency>(model?.residency ?? 'global');
  const [capabilities, setCapabilities] = useState<Capability[]>(model?.capabilities ?? ['stream']);
  const [enabled, setEnabled] = useState(model?.enabled ?? false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const found = {
      ...(deployment.trim() ? {} : { deployment: t('endpoints.deploymentRequired') }),
      ...(target ? {} : { target: t('endpoints.chooseEndpoint') }),
      ...(reasonError(reason, t) ? { reason: reasonError(reason, t) as string } : {}),
    };
    setErrors(found);
    setFailed(undefined);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      const id = model?.id ?? `${target}/${deployment.trim().toLowerCase()}`;
      const saved = await api.saveModel(
        id,
        {
          endpoint: target,
          deployment: deployment.trim(),
          ...(family.trim() ? { family: family.trim() } : {}),
          residency,
          capabilities,
          enabled,
        },
        reason.trim(),
      );
      onSaved(saved);
    } catch (error) {
      setFailed(problemText(error, tRef.current('endpoints.saveModelFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePanel labelledBy="model-panel-h" onClose={onClose}>
      <div className="panel-head">
        <span className="eyebrow">{t('endpoints.panelEyebrow')}</span>
        <Heading level={2} data-size="xs" id="model-panel-h" tabIndex={-1}>
          {model ? t('endpoints.editModel', { model: model.deployment }) : t('endpoints.addModel')}
        </Heading>
      </div>
      <div className="panel-body">
        <div className="field">
          <Label htmlFor="model-endpoint">{t('endpoints.endpoint')}</Label>
          <Select
            id="model-endpoint"
            value={target}
            disabled={Boolean(model)}
            onChange={(e) => setTarget(e.target.value)}
          >
            {endpoints.map((e) => (
              <SelectOption key={e} value={e}>
                {e}
              </SelectOption>
            ))}
          </Select>
          {errors.target ? <ValidationMessage>{errors.target}</ValidationMessage> : null}
        </div>
        <Textfield
          label={t('endpoints.deployment')}
          description={t('endpoints.deploymentDescription')}
          value={deployment}
          readOnly={Boolean(model)}
          onChange={(e) => setDeployment(e.target.value)}
          error={errors.deployment}
        />
        <Textfield
          label={t('endpoints.family')}
          description={t('endpoints.familyDescription')}
          value={family}
          onChange={(e) => setFamily(e.target.value)}
        />
        <div className="field">
          <Label htmlFor="model-residency">{t('endpoints.residency')}</Label>
          <Select
            id="model-residency"
            value={residency}
            onChange={(e) => setResidency(e.target.value as Residency)}
          >
            {(Object.keys(residencyLabel) as Residency[]).map((r) => (
              <SelectOption key={r} value={r}>
                {t(residencyLabel[r])}
              </SelectOption>
            ))}
          </Select>
        </div>
        <Fieldset>
          <FieldsetLegend>{t('endpoints.can')}</FieldsetLegend>
          {(Object.keys(capabilityLabel) as Capability[]).map((c) => (
            <Checkbox
              key={c}
              label={t(capabilityLabel[c])}
              checked={capabilities.includes(c)}
              onChange={(e) =>
                setCapabilities((all) =>
                  e.target.checked ? [...all, c] : all.filter((x) => x !== c),
                )
              }
            />
          ))}
        </Fieldset>
        <Switch
          label={t('endpoints.inUse')}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <ReasonField value={reason} error={errors.reason} onChange={setReason} />
        {failed ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {failed}
          </Alert>
        ) : null}
        <div className="actions-row">
          <Button loading={busy} onClick={() => void save()}>
            {t('endpoints.saveModel')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </SidePanel>
  );
};

const parsePrice = (value: string) => {
  const n = Number(value.trim().replace(',', '.'));
  return value.trim() && Number.isFinite(n) && n >= 0 ? n : undefined;
};

export const PriceDialog = ({
  api,
  model,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  model: OperatorModel | undefined;
  onClose: () => void;
  onSaved: (model: OperatorModel) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [shown, setShown] = useState<string | undefined>();
  if (model && shown !== model.id) {
    setShown(model.id);
    setInput(
      model.price ? f.number(model.price.inputPerThousand, { maximumFractionDigits: 6 }) : '',
    );
    setOutput(
      model.price ? f.number(model.price.outputPerThousand, { maximumFractionDigits: 6 }) : '',
    );
  }
  return (
    <ReasonDialog
      open={Boolean(model)}
      title={model ? t('endpoints.priceTitle', { model: model.deployment }) : ''}
      text={t('endpoints.priceText')}
      confirmLabel={t('endpoints.savePrice')}
      onClose={() => {
        setShown(undefined);
        onClose();
      }}
      onConfirm={async (reason) => {
        if (!model) return;
        const price = {
          inputPerThousand: parsePrice(input),
          outputPerThousand: parsePrice(output),
        };
        if (price.inputPerThousand === undefined || price.outputPerThousand === undefined)
          throw new DialogError(t('endpoints.priceInvalid'));
        await api.setModelPrice(model.id, price as ModelPrice, reason);
        onSaved({ ...model, price: price as ModelPrice });
      }}
    >
      <Textfield
        label={t('endpoints.priceIn')}
        inputMode="decimal"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <Textfield
        label={t('endpoints.priceOut')}
        inputMode="decimal"
        value={output}
        onChange={(e) => setOutput(e.target.value)}
      />
    </ReasonDialog>
  );
};

export const Endpoints = ({
  api,
  endpoints,
  models,
  onAdded,
  onRemoved,
  onAddModel,
  onProcessorSaved,
}: {
  api: ApiClient;
  endpoints: ConfigEntry[];
  models: OperatorModel[];
  onAdded: () => void;
  onRemoved: (id: string) => void;
  onAddModel: (endpoint: string) => void;
  onProcessorSaved: (id: string) => void;
}) => {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [editingEndpoint, setEditingEndpoint] = useState<ConfigEntry | undefined>();
  const [removing, setRemoving] = useState<string | undefined>();
  const [inUse, setInUse] = useState<InUse[] | undefined>();
  const [recording, setRecording] = useState<string | undefined>();
  const [records, reloadRecords] = useAsync((signal) => api.processorRecords(signal), [api]);
  const recordOf = (id: string): EndpointProcessorRecord | undefined =>
    records.status === 'ready' ? records.data.find((r) => r.endpoint === id) : undefined;
  const tenantName = useTenantNames(api);

  const remove = async (reason: string) => {
    if (!removing) return;
    try {
      await api.deleteModelEndpoint(removing, reason);
    } catch (error) {
      const used = inUseOf(error, 'services');
      if (used) {
        setInUse(used);
        throw new DialogError(t('endpoints.stillInUse'));
      }
      throw error;
    }
    onRemoved(removing);
  };

  return (
    <section className="stack" aria-labelledby="endepunkter-h">
      <div className="card-head">
        <Heading level={2} data-size="xs" id="endepunkter-h">
          {t('endpoints.title')}
        </Heading>
        <Button variant="secondary" data-size="sm" onClick={() => setAdding(true)}>
          {t('endpoints.addTitle')}
        </Button>
      </div>
      <Paragraph data-size="sm">{t('endpoints.intro')}</Paragraph>
      {endpoints.length === 0 ? (
        <Paragraph>{t('endpoints.none')}</Paragraph>
      ) : (
        <TableRegion label={t('endpoints.tableLabel')}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('endpoints.colEndpoint')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('endpoints.colFamilies')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('endpoints.colSecret')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('endpoints.colModels')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('endpoints.colProcessor')}</TableHeaderCell>
                <TableHeaderCell scope="col">
                  <VisuallyHidden>{t('endpoints.colActions')}</VisuallyHidden>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {endpoints.map((e) => {
                const spec = specOf(e);
                return (
                  <TableRow key={e.id}>
                    <TableHeaderCell scope="row">
                      <span className="two-line">
                        <strong>{e.id}</strong>
                        <span className="meta">{spec.baseURL ?? ''}</span>
                      </span>
                    </TableHeaderCell>
                    <TableCell>
                      {spec.families.length > 0 ? spec.families.join(', ') : t('endpoints.unknown')}
                    </TableCell>
                    <TableCell>{spec.secret ?? t('endpoints.noSecret')}</TableCell>
                    <TableCell>{models.filter((m) => m.endpoint === e.id).length}</TableCell>
                    <TableCell>
                      {records.status === 'ready' ? (
                        <span className="two-line">
                          {recordOf(e.id)?.record ? (
                            <Tag data-size="sm" data-color="success">
                              {t('endpoints.processorRecorded')}
                            </Tag>
                          ) : (
                            <Tag data-size="sm" data-color="warning">
                              {t('endpoints.processorMissing')}
                            </Tag>
                          )}
                          <span className="meta">
                            {recordOf(e.id)?.record
                              ? t('endpoints.processorRecordedHint')
                              : t('endpoints.processorMissingHint')}
                          </span>
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className="row-actions">
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('endpoints.editId', { id: e.id })}
                          onClick={() => setEditingEndpoint(e)}
                        >
                          {t('endpoints.edit')}
                        </Button>
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('endpoints.processorOpenFor', { id: e.id })}
                          onClick={() => setRecording(e.id)}
                        >
                          {recordOf(e.id)?.record
                            ? t('endpoints.processorChange')
                            : t('endpoints.processorAdd')}
                        </Button>
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('endpoints.addModelUnder', { id: e.id })}
                          onClick={() => onAddModel(e.id)}
                        >
                          {t('endpoints.addModel')}
                        </Button>
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-label={t('endpoints.removeId', { id: e.id })}
                          onClick={() => {
                            setInUse(undefined);
                            setRemoving(e.id);
                          }}
                        >
                          {t('endpoints.remove')}
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableRegion>
      )}
      {recording ? (
        <ProcessorRecordForm
          api={api}
          endpoint={recording}
          current={recordOf(recording)}
          onClose={() => setRecording(undefined)}
          onSaved={() => {
            setRecording(undefined);
            onProcessorSaved(recording);
            reloadRecords();
          }}
        />
      ) : null}
      {adding || editingEndpoint ? (
        <EndpointForm
          key={editingEndpoint?.id ?? 'new'}
          api={api}
          existing={editingEndpoint}
          onClose={() => {
            setAdding(false);
            setEditingEndpoint(undefined);
          }}
          onSaved={() => {
            setAdding(false);
            setEditingEndpoint(undefined);
            onAdded();
          }}
        />
      ) : null}
      <ReasonDialog
        open={Boolean(removing)}
        title={removing ? t('endpoints.removeId', { id: removing }) : ''}
        text={t('endpoints.removeText')}
        confirmLabel={t('endpoints.remove')}
        onClose={() => setRemoving(undefined)}
        onConfirm={remove}
      >
        {inUse?.length ? (
          <div className="stack-sm">
            <span className="label-strong">{t('endpoints.usedBy', { count: inUse.length })}</span>
            <InUseList items={inUse} tenantName={tenantName} />
          </div>
        ) : null}
      </ReasonDialog>
    </section>
  );
};
