import {
  Alert,
  Button,
  Checkbox,
  Fieldset,
  FieldsetLegend,
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
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api';
import { useT, type Format, type T } from '../i18n';
import { useTenantNames } from '../tenant-names';
import { useAsync } from '../hooks';
import { EmptyState, ErrorState, Loading } from '../states';
import type {
  Capability,
  ModelClassification,
  OperatorModel,
  RefreshResult,
  ModelPrice,
  Residency,
} from '../types';
import { Flash, PageHeader, ReasonDialog, TableRegion, useFlash, VisuallyHidden } from '../ui';
import {
  capabilityLabel,
  Endpoints,
  ModelForm,
  PriceDialog,
  residencyLabel,
} from './models/Endpoints';
import { ParametersDialog, parameterNames, RejectedHint, ruleText } from './models/Parameters';
import { reasonProblem, reasonTooShort } from '../reason';

export const priceText = (price: ModelPrice | null | undefined, f: Format, t: T) =>
  price
    ? t('models.priceText', {
        input: f.number(price.inputPerThousand, { maximumFractionDigits: 4 }),
        output: f.number(price.outputPerThousand, { maximumFractionDigits: 4 }),
      })
    : t('models.unpriced');

const capabilities = Object.keys(capabilityLabel) as Capability[];
const residencies = Object.keys(residencyLabel) as Residency[];

const ModelRow = ({
  model,
  busy,
  error,
  onChange,
  onEdit,
  onPrice,
  onParameters,
}: {
  model: OperatorModel;
  busy: boolean;
  error: string | undefined;
  onChange: (change: ModelClassification) => void;
  onEdit: () => void;
  onPrice: () => void;
  onParameters: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const fieldId = `residency-${model.id.replace(/[^a-z0-9]/gi, '-')}`;
  return (
    <TableRow>
      <TableCell>
        <strong>{model.deployment}</strong>
        <br />
        <span className="muted">{model.id}</span>
        {model.family && model.family !== model.deployment ? (
          <span className="muted">
            <br />
            {model.family}
          </span>
        ) : null}
        {parameterNames.map((n) =>
          model.parameters?.[n] ? (
            <span key={n} className="muted">
              <br />
              {ruleText(t, n, model.parameters[n])}
            </span>
          ) : null,
        )}
        <RejectedHint model={model} />
        {error ? (
          <Paragraph role="alert" data-size="sm" className="row-error">
            {error}
          </Paragraph>
        ) : null}
      </TableCell>
      <TableCell>{model.endpoint}</TableCell>
      <TableCell>
        {model.origin === 'discovered' ? t('models.discoveredAuto') : t('models.fromCatalog')}
        {model.origin === 'discovered' && !model.classified ? (
          <>
            <br />
            <Tag data-color="warning" data-size="sm">
              {t('models.unconfirmed')}
            </Tag>
          </>
        ) : null}
      </TableCell>
      <TableCell>
        <Label htmlFor={fieldId} className="visually-hidden">
          {t('models.residencyFor', { model: model.deployment })}
        </Label>
        <Select
          id={fieldId}
          value={model.residency}
          aria-describedby={`${fieldId}-hint`}
          disabled={busy}
          onChange={(e) => onChange({ residency: e.target.value as Residency })}
        >
          {residencies.map((r) => (
            <SelectOption key={r} value={r}>
              {t(residencyLabel[r])}
            </SelectOption>
          ))}
        </Select>
        <span id={`${fieldId}-hint`} className="muted">
          {t('models.globalStandardHint')}
        </span>
      </TableCell>
      <TableCell>{priceText(model.price, f, t)}</TableCell>
      <TableCell>
        <Fieldset data-size="sm">
          <FieldsetLegend className="visually-hidden">
            {t('models.canFor', { model: model.deployment })}
          </FieldsetLegend>
          {capabilities.map((c) => (
            <Checkbox
              key={c}
              label={
                <>
                  {t(capabilityLabel[c])}{' '}
                  <span className="visually-hidden">
                    {t('models.forModel', { model: model.deployment })}
                  </span>
                </>
              }
              checked={model.capabilities.includes(c)}
              disabled={busy}
              onChange={(e) =>
                onChange({
                  capabilities: e.target.checked
                    ? [...model.capabilities, c]
                    : model.capabilities.filter((x) => x !== c),
                })
              }
            />
          ))}
        </Fieldset>
      </TableCell>
      <TableCell>
        <Switch
          aria-label={t('models.inUse', { model: model.deployment })}
          checked={model.enabled}
          disabled={busy}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
      </TableCell>
      <TableCell>
        <span className="row-actions">
          <Button
            variant="tertiary"
            data-size="sm"
            aria-label={t('models.editModel', { model: model.deployment })}
            onClick={onEdit}
          >
            {t('models.edit')}
          </Button>
          <Button
            variant="tertiary"
            data-size="sm"
            aria-label={t('models.setPriceFor', { model: model.deployment })}
            onClick={onPrice}
          >
            {t('models.setPrice')}
          </Button>
          <Button
            variant="tertiary"
            data-size="sm"
            aria-label={t('modelParameters.openFor', { model: model.deployment })}
            onClick={onParameters}
          >
            {t('modelParameters.open')}
          </Button>
        </span>
      </TableCell>
    </TableRow>
  );
};

export const Models = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [state, retry] = useAsync((signal) => api.listModels(signal), [api]);
  const [models, setModels] = useState<OperatorModel[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState<RefreshResult | 'failed' | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [needsReason, setNeedsReason] = useState(false);
  const [retiring, setRetiring] = useState<OperatorModel | undefined>();
  const [editing, setEditing] = useState<{ model?: OperatorModel; endpoint?: string }>();
  const [pricing, setPricing] = useState<OperatorModel | undefined>();
  const [parametersOf, setParametersOf] = useState<OperatorModel | undefined>();
  const [endpoints, reloadEndpoints] = useAsync((signal) => api.modelEndpoints(signal), [api]);
  const flash = useFlash();
  const tenantName = useTenantNames(api);
  const endpointIds =
    endpoints.status === 'ready'
      ? endpoints.data.map((e) => e.id)
      : [...new Set(models.map((m) => m.endpoint))];
  const replace = (updated: OperatorModel) =>
    setModels((all) =>
      all.some((m) => m.id === updated.id)
        ? all.map((m) => (m.id === updated.id ? updated : m))
        : [...all, updated],
    );

  const reasonGiven = () => {
    const ok = !reasonTooShort(reason);
    setNeedsReason(!ok);
    return ok;
  };

  useEffect(() => {
    if (state.status === 'ready') setModels(state.data);
  }, [state]);

  const change = async (model: OperatorModel, classification: ModelClassification) => {
    if (!reasonGiven()) return;
    setBusy((b) => new Set(b).add(model.id));
    setErrors(({ [model.id]: _, ...rest }) => rest);
    try {
      const updated = await api.classifyModel(model.id, classification, reason.trim());
      setModels((all) => all.map((m) => (m.id === updated.id ? updated : m)));
      flash.show(tRef.current('models.saved', { model: updated.deployment }));
    } catch {
      setErrors((e) => ({
        ...e,
        [model.id]: tRef.current('models.saveFailed', { model: model.deployment }),
      }));
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(model.id);
        return next;
      });
    }
  };

  const refresh = async () => {
    if (!reasonGiven()) return;
    setRefreshing(true);
    setRefreshed(undefined);
    try {
      setRefreshed(await api.refreshModels(reason.trim()));
      retry();
    } catch {
      setRefreshed('failed');
    } finally {
      setRefreshing(false);
    }
  };

  const onChange = (model: OperatorModel, classification: ModelClassification) => {
    if (classification.enabled === false) {
      setRetiring(model);
      return;
    }
    void change(model, classification);
  };

  return (
    <>
      <PageHeader title={t('models.title')} intro={t('models.intro')} />
      <Flash message={flash.message} />
      <Paragraph data-size="sm">
        {t.rich('models.discoveredNote', { strong: (c) => <strong>{c}</strong> })}
      </Paragraph>
      <Textfield
        className="reason"
        label={t('common.reason')}
        description={t('models.reasonDescription')}
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
          if (!reasonTooShort(e.target.value)) setNeedsReason(false);
        }}
        error={needsReason ? reasonProblem(t, reason) : undefined}
      />
      <div className="actions">
        <Button variant="secondary" onClick={refresh} loading={refreshing}>
          {t('models.refresh')}
        </Button>
      </div>
      {refreshed === 'failed' ? (
        <Alert data-color="danger" role="alert">
          {t('models.refreshFailed')}
        </Alert>
      ) : null}
      {refreshed && refreshed !== 'failed' ? (
        <Alert data-color={refreshed.failed.length > 0 ? 'warning' : 'success'} role="status">
          <Paragraph>{t('models.discovered', { count: refreshed.discovered })}</Paragraph>
          {refreshed.failed.length > 0 ? (
            <>
              <Paragraph>{t('models.providersFailed')}</Paragraph>
              <ul>
                {refreshed.failed.map((x) => (
                  <li key={x.endpoint}>
                    {x.endpoint}: {x.error}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Alert>
      ) : null}
      {state.status === 'loading' ? <Loading label={t('models.loading')} /> : null}
      {state.status === 'error' ? <ErrorState error={state.error} onRetry={retry} /> : null}
      {state.status === 'ready' && models.length === 0 ? (
        <EmptyState title={t('models.noneTitle')}>
          <Paragraph>{t('models.noneText')}</Paragraph>
        </EmptyState>
      ) : null}
      {state.status === 'ready' && models.length > 0 ? (
        <TableRegion label={t('models.tableLabel')}>
          <Table className="models-table">
            <TableHead>
              <TableRow>
                <TableHeaderCell scope="col">{t('models.colModel')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('models.colProvider')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('models.colSource')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('models.colResidency')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('models.colPrice')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('models.colCan')}</TableHeaderCell>
                <TableHeaderCell scope="col">{t('models.colEnabled')}</TableHeaderCell>
                <TableHeaderCell scope="col">
                  <VisuallyHidden>{t('models.colActions')}</VisuallyHidden>
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {models.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  busy={busy.has(m.id)}
                  error={errors[m.id]}
                  onChange={(c) => onChange(m, c)}
                  onEdit={() => setEditing({ model: m })}
                  onPrice={() => setPricing(m)}
                  onParameters={() => setParametersOf(m)}
                />
              ))}
            </TableBody>
          </Table>
        </TableRegion>
      ) : null}
      {endpoints.status === 'loading' ? <Loading label={t('models.loadingEndpoints')} /> : null}
      {endpoints.status === 'error' ? (
        <ErrorState error={endpoints.error} onRetry={reloadEndpoints} />
      ) : null}
      {endpoints.status === 'ready' ? (
        <Endpoints
          api={api}
          endpoints={endpoints.data}
          models={models}
          onAdded={() => {
            flash.show(t('models.endpointAdded'));
            reloadEndpoints();
          }}
          onRemoved={(id) => {
            setModels((all) => all.filter((m) => m.endpoint !== id));
            flash.show(t('models.endpointRemoved', { id }));
            reloadEndpoints();
          }}
          onAddModel={(endpoint) => setEditing({ endpoint })}
        />
      ) : null}
      {editing ? (
        <ModelForm
          api={api}
          endpoints={endpointIds}
          model={editing.model}
          endpoint={editing.endpoint}
          onClose={() => setEditing(undefined)}
          onSaved={(saved) => {
            replace(saved);
            setEditing(undefined);
            flash.show(t('models.saved', { model: saved.deployment }));
          }}
        />
      ) : null}
      <PriceDialog
        api={api}
        model={pricing}
        onClose={() => setPricing(undefined)}
        onSaved={(saved) => {
          replace(saved);
          flash.show(t('models.priceSaved', { model: saved.deployment }));
        }}
      />
      <ParametersDialog
        api={api}
        model={parametersOf}
        onClose={() => setParametersOf(undefined)}
        onSaved={(saved) => {
          replace(saved);
          flash.show(t('modelParameters.saved', { model: saved.deployment }));
        }}
      />
      <ReasonDialog
        open={Boolean(retiring)}
        title={retiring ? t('models.retireTitle', { model: retiring.deployment }) : ''}
        text={t('models.retireText')}
        confirmLabel={t('models.retire')}
        onClose={() => setRetiring(undefined)}
        onConfirm={async (why) => {
          if (!retiring) return;
          const updated = await api.classifyModel(retiring.id, { enabled: false }, why);
          setModels((all) => all.map((m) => (m.id === updated.id ? updated : m)));
          flash.show(tRef.current('models.retired', { model: updated.deployment }));
        }}
      >
        <div className="stack-sm">
          <span className="label-strong">
            {retiring?.usage
              ? t('models.affectedCount', { count: retiring.usage.length })
              : t('models.affected')}
          </span>
          {retiring?.usage?.length ? (
            <ul className="service-list">
              {retiring.usage.map((u) => (
                <li key={`${u.tenant}/${u.service}/${u.role}`}>
                  <span>
                    <strong>{u.service}</strong> · {tenantName(u.tenant)}
                  </span>
                  <span className="meta">{u.role}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Paragraph data-size="sm">{t('models.usageUnknown')}</Paragraph>
          )}
        </div>
      </ReasonDialog>
    </>
  );
};
