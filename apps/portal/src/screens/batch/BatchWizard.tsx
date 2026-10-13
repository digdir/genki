import {
  Alert,
  Button,
  Chip,
  Details,
  Field,
  Fieldset,
  Heading,
  Label,
  Paragraph,
  Select,
  Table,
  Tag,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ApiClient } from '../../api';
import { ApiError } from '../../api/error';
import type {
  BatchEstimate,
  BatchFilters,
  BatchFilterField,
  BatchSourceDataset,
} from '../../api/batch-runs';
import type { PlaygroundInputField } from '../../api/playground';
import {
  filledValues,
  formErrors,
  formInput,
  InputForm,
  type FormValues,
} from '../../components/playground/InputForm';
import { useT, type Format, type T } from '../../i18n';
import { useAsync } from '../../hooks';
import { problemTitle } from '../quality/shared';
import { quotaOf, tokensOf } from '../usage/model';
import { fieldLabel, kroner, reasonError, selectionName, shownValues } from './shared';

const steps = [
  'batchWizard.stepPick',
  'batchWizard.stepInput',
  'batchWizard.stepCost',
  'batchWizard.stepStart',
] as const;
const chipLimit = 8;
const bigSelection = 1000;
const countDelayMs = 400;

type Pick =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'error'; message: string }
  | { state: 'ready'; estimate: BatchEstimate };

const range = (low: string, high: string) => (low === high ? low : `${low}–${high}`);

const costRange = (t: T, f: Format, e: BatchEstimate) =>
  e.costMicroNok ? range(kroner(t, f, e.costMicroNok.low), kroner(t, f, e.costMicroNok.high)) : '';

const suggestedCap = (e: BatchEstimate) =>
  e.costMicroNok
    ? String(Math.max(1, Math.ceil((e.costMicroNok.high * 1.2) / 1_000_000)))
    : String(Math.ceil(e.tokens.high * 1.2));

const tokensPerItem = (e: BatchEstimate) =>
  Math.round(
    (e.perItem.inputTokens.low +
      e.perItem.inputTokens.high +
      e.perItem.outputTokens.low +
      e.perItem.outputTokens.high) /
      2,
  );

const shortTokens = (t: T, f: Format, n: number) =>
  n >= 1_000_000
    ? t('batchWizard.million', { value: f.number(n / 1_000_000, { maximumFractionDigits: 1 }) })
    : f.number(n);

const FilterField = ({
  field,
  chosen,
  onChange,
}: {
  field: BatchFilterField;
  chosen: string[];
  onChange: (values: string[]) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const values = shownValues(field.field, field.values);
  if (values.length <= chipLimit)
    return (
      <Fieldset className="batch-filter-chips">
        <Fieldset.Legend>{fieldLabel(t, field.field)}</Fieldset.Legend>
        <div className="tag-row">
          {values.map((v) => (
            <Chip.Checkbox
              key={v.value}
              checked={chosen.includes(v.value)}
              onChange={() =>
                onChange(
                  chosen.includes(v.value)
                    ? chosen.filter((c) => c !== v.value)
                    : [...chosen, v.value],
                )
              }
            >
              {v.value}
            </Chip.Checkbox>
          ))}
        </div>
      </Fieldset>
    );
  return (
    <Field className="batch-filter-select">
      <Label htmlFor={id}>{fieldLabel(t, field.field)}</Label>
      <Select
        id={id}
        value={chosen[0] ?? ''}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
      >
        <Select.Option value="">{t('batchWizard.all')}</Select.Option>
        {values.map((v) => (
          <Select.Option key={v.value} value={v.value}>
            {v.value} ({f.number(v.count)})
          </Select.Option>
        ))}
      </Select>
    </Field>
  );
};

const ApiCall = ({ line, body }: { line: string; body: unknown }) => {
  const t = useT();
  return (
    <Details>
      <Details.Summary>{t('batchWizard.showApi')}</Details.Summary>
      <Details.Content>
        <div className="stack-sm">
          <code className="batch-api-line">{line}</code>
          <pre className="batch-api-body">{JSON.stringify(body, null, 2)}</pre>
        </div>
      </Details.Content>
    </Details>
  );
};

export const BatchWizard = ({
  api,
  tenant,
  serviceId,
  sources,
  onStarted,
  onCancel,
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  sources: BatchSourceDataset[];
  onStarted: (runId: string) => void;
  onCancel: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  const ids = { dataset: useId() };
  const [step, setStep] = useState(1);
  const [dataset, setDataset] = useState(sources[0]?.id ?? '');
  const [filters, setFilters] = useState<BatchFilters>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [pick, setPick] = useState<Pick>({ state: 'idle' });
  const [values, setValues] = useState<FormValues>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState('');
  const [estimate, setEstimate] = useState<BatchEstimate>();
  const [estimateError, setEstimateError] = useState('');
  const [cap, setCap] = useState('');
  const [capError, setCapError] = useState('');
  const [unpricedWhy, setUnpricedWhy] = useState('');
  const [unpricedError, setUnpricedError] = useState('');
  const [approvalWhy, setApprovalWhy] = useState('');
  const [approvalError, setApprovalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const asked = useRef(0);
  const source = sources.find((s) => s.id === dataset);
  const service = useRef(serviceId);
  service.current = serviceId;

  const [fields] = useAsync(async (): Promise<PlaygroundInputField[]> => {
    const definition = (await api.getDefinition(tenant, 'Service', serviceId)).latest.definition;
    return api.draftInputFields(tenant, definition);
  }, [api, tenant, serviceId]);
  const inputFields = fields.status === 'ready' ? fields.data : [];
  const [settings] = useAsync(
    (signal) => api.tenantEffectiveSettings(tenant, signal),
    [api, tenant],
  );
  const [usage] = useAsync(
    (signal) => api.usage(tenant, Math.max(new Date().getDate(), 1), signal),
    [api, tenant],
  );

  const known = pick.state === 'ready' ? pick.estimate : undefined;
  const allKnown = !!known && known.items <= known.preview.length;
  const kept = known ? known.preview.filter((d) => !removed.includes(d.id)) : [];
  const count = known ? known.items - (allKnown ? removed.length : 0) : 0;
  const documents = allKnown && removed.length ? kept.map((d) => d.id) : undefined;

  useEffect(() => {
    if (!dataset) return;
    const ask = ++asked.current;
    setPick({ state: 'loading' });
    const timer = setTimeout(() => {
      api.batchRuns
        .estimate(
          tenant,
          service.current,
          { dataset, filters, sample: false },
          'Telte dokumenter for samlet jobb',
        )
        .then((result) => {
          if (ask === asked.current) setPick({ state: 'ready', estimate: result });
        })
        .catch((e: unknown) => {
          if (ask !== asked.current) return;
          setPick(
            e instanceof ApiError && e.status === 422
              ? { state: 'none' }
              : { state: 'error', message: problemTitle(e, t) },
          );
        });
    }, countDelayMs);
    return () => clearTimeout(timer);
  }, [api, tenant, dataset, filters]);

  const quota = settings.status === 'ready' ? quotaOf(settings.data) : null;
  const used = usage.status === 'ready' ? tokensOf(usage.data.totals) : 0;
  const quotaLeft = quota === null ? null : Math.max(0, quota - used);
  const overQuota = !!estimate && quotaLeft !== null && estimate.tokens.high > quotaLeft;
  const needsApproval = !!estimate?.approval?.required;

  const measure = async (sample: boolean) => {
    setBusy(true);
    setEstimateError('');
    try {
      const input = formInput(inputFields, values);
      const result = await api.batchRuns.estimate(
        tenant,
        serviceId,
        {
          dataset,
          filters,
          ...(documents ? { documents } : {}),
          ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
          ...(Object.keys(input).length ? { input } : {}),
          ...(sample ? {} : { sample: false }),
        },
        sample
          ? 'Målte kostnad for samlet jobb med prøvekjøring'
          : 'Beregnet kostnad for samlet jobb',
      );
      setEstimate(result);
      setCap(suggestedCap(result));
      setCapError('');
    } catch (e) {
      setEstimateError(problemTitle(e, t));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!estimate || busy) return;
    const value = Number(cap.replace(',', '.'));
    setBusy(true);
    setError('');
    try {
      const run = await api.batchRuns.start(
        tenant,
        serviceId,
        {
          estimate: estimate.id,
          ...(estimate.priced ? { maxCostNok: value } : { maxTokens: Math.round(value) }),
          ...(needsApproval ? { approval: approvalWhy.trim() } : {}),
        },
        estimate.priced
          ? `Startet samlet jobb over ${estimate.items} dokumenter`
          : `Startet samlet jobb over ${estimate.items} dokumenter uten pris: ${unpricedWhy.trim()}`,
      );
      onStarted(run.id);
    } catch (e) {
      setError(problemTitle(e, t));
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (busy) return;
    if (step === 1) {
      if (count === 0) return;
      setStep(2);
      return;
    }
    if (step === 2) {
      const missing = formErrors(inputFields, values);
      setFieldErrors(missing);
      if (Object.keys(missing).length) return;
      setEstimate(undefined);
      setStep(3);
      void measure(false);
      return;
    }
    if (step === 3) {
      if (!estimate || overQuota) return;
      const value = Number(cap.replace(',', '.'));
      const capProblem =
        !Number.isFinite(value) || value <= 0
          ? estimate.priced
            ? t('batchWizard.capCurrency')
            : t('batchWizard.capTokens')
          : '';
      const unpriced = estimate.priced ? '' : reasonError(t, unpricedWhy);
      const approval = needsApproval ? reasonError(t, approvalWhy) : '';
      setCapError(capProblem);
      setUnpricedError(unpriced);
      setApprovalError(approval);
      if (capProblem || unpriced || approval) return;
      setStep(4);
      return;
    }
    void start();
  };

  const nextBlocked =
    (step === 1 && count === 0) || (step === 3 && (!estimate || overQuota)) || busy;

  const filterBody = {
    dataset,
    filters,
    ...(documents ? { documents } : {}),
    ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    ...(Object.keys(formInput(inputFields, values)).length
      ? { input: formInput(inputFields, values) }
      : {}),
  };
  const base = `/tenants/${tenant}/services/${serviceId}/batch-runs`;

  if (sources.length === 0)
    return <Paragraph data-size="sm">{t('batchWizard.noSources')}</Paragraph>;

  return (
    <div className="batch-wizard">
      <nav aria-label={t('batchWizard.stepsNav')} className="batch-steps">
        <span className="batch-steps-count">
          {t('batchWizard.stepCount', { step, total: steps.length })}
        </span>
        <ol className="plain-list">
          {steps.map((labelKey, i) => {
            const n = i + 1;
            return (
              <li
                key={labelKey}
                aria-current={n === step ? 'step' : undefined}
                className={n === step ? 'current' : n < step ? 'done' : undefined}
              >
                <span aria-hidden="true" className="batch-step-dot">
                  {n < step ? '✓' : n}
                </span>
                {t(labelKey)}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="stack batch-step">
        <div aria-live="polite">
          {flash ? (
            <Alert data-color="success" data-size="sm">
              {flash}
            </Alert>
          ) : null}
        </div>
        {step === 1 ? (
          <section aria-labelledby="batch-s1-h" className="stack">
            <Heading level={3} data-size="sm" id="batch-s1-h">
              {t('batchWizard.stepPick')}
            </Heading>
            <div className="batch-filters stack-sm">
              <Field className="batch-filter-select">
                <Label htmlFor={ids.dataset}>{t('batchWizard.dataset')}</Label>
                <Select
                  id={ids.dataset}
                  value={dataset}
                  onChange={(e) => {
                    setDataset(e.target.value);
                    setFilters({});
                    setRemoved([]);
                  }}
                >
                  {sources.map((s) => (
                    <Select.Option key={s.id} value={s.id}>
                      {s.name}
                      {s.usedByService ? t('batchWizard.usedByService') : ''}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
              <div className="batch-filter-grid">
                {source?.filters.map((f) => (
                  <FilterField
                    key={`${dataset}/${f.field}`}
                    field={f}
                    chosen={filters[f.field] ?? []}
                    onChange={(chosen) => {
                      setRemoved([]);
                      setFilters((current) => {
                        const rest = Object.fromEntries(
                          Object.entries(current).filter(([k]) => k !== f.field),
                        );
                        return chosen.length ? { ...rest, [f.field]: chosen } : rest;
                      });
                    }}
                  />
                ))}
              </div>
            </div>
            <p aria-live="polite" className="batch-count">
              {pick.state === 'loading' || pick.state === 'idle'
                ? t('batchWizard.counting')
                : pick.state === 'ready' && count > 0
                  ? t('batchWizard.fits', { count })
                  : pick.state === 'error'
                    ? ''
                    : t('batchWizard.noneFit')}
            </p>
            {pick.state === 'none' || (pick.state === 'ready' && count === 0) ? (
              <Alert data-color="warning" data-size="sm">
                {t('batchWizard.noneFitFilters')}
              </Alert>
            ) : null}
            {pick.state === 'error' ? (
              <Alert data-color="danger" data-size="sm">
                {pick.message}
              </Alert>
            ) : null}
            {count > bigSelection ? (
              <Alert data-color="warning" data-size="sm">
                {t('batchWizard.bigSelection', { count, max: bigSelection })}
              </Alert>
            ) : null}
            {known && kept.length > 0 ? (
              <div
                tabIndex={0}
                role="region"
                aria-label={t('batchWizard.firstDocuments')}
                className="table-scroll"
              >
                <Table data-size="sm" className="batch-preview-table">
                  <Table.Head>
                    <Table.Row>
                      <Table.HeaderCell scope="col">{t('batchWizard.colTitle')}</Table.HeaderCell>
                      {allKnown ? (
                        <Table.HeaderCell scope="col">
                          <span className="visually-hidden">{t('batchWizard.colAction')}</span>
                        </Table.HeaderCell>
                      ) : null}
                    </Table.Row>
                  </Table.Head>
                  <Table.Body>
                    {kept.slice(0, 8).map((d) => (
                      <Table.Row key={d.id}>
                        <Table.Cell>{d.title}</Table.Cell>
                        {allKnown ? (
                          <Table.Cell>
                            <Button
                              variant="tertiary"
                              data-size="sm"
                              aria-label={t('batchWizard.takeOutLabel', { title: d.title })}
                              onClick={() => {
                                setRemoved((r) => [...r, d.id]);
                                setFlash(t('batchWizard.takenOut', { title: d.title }));
                              }}
                            >
                              {t('batchWizard.takeOut')}
                            </Button>
                          </Table.Cell>
                        ) : null}
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            ) : null}
            {known && count > 8 ? (
              <span className="meta">{t('batchWizard.showingFirst', { count })}</span>
            ) : null}
          </section>
        ) : null}

        {step === 2 ? (
          <section aria-labelledby="batch-s2-h" className="stack batch-narrow">
            <Heading level={3} data-size="sm" id="batch-s2-h">
              {t('batchWizard.stepInput')}
            </Heading>
            {inputFields.length ? (
              <InputForm
                fields={inputFields}
                values={values}
                errors={fieldErrors}
                intro={t('batchWizard.inputIntro')}
                onChange={(id, value) => {
                  setValues((v) => ({ ...v, [id]: value }));
                  setFieldErrors((e) =>
                    Object.fromEntries(Object.entries(e).filter(([k]) => k !== id)),
                  );
                }}
              />
            ) : (
              <Paragraph>{t('batchWizard.inputIntro')}</Paragraph>
            )}
            <Textfield
              multiline
              rows={2}
              label={t('batchWizard.extra')}
              description={t('batchWizard.extraHint')}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </section>
        ) : null}

        {step === 3 ? (
          <section aria-labelledby="batch-s3-h" className="stack">
            <Heading level={3} data-size="sm" id="batch-s3-h">
              {t('batchWizard.stepCost')}
            </Heading>
            {overQuota && estimate && quota !== null ? (
              <Alert data-color="danger">
                <Heading level={4} data-size="2xs">
                  {t('batchWizard.quotaHeading')}
                </Heading>
                <Paragraph>
                  {t('batchWizard.quotaBody', {
                    need: shortTokens(t, f, estimate.tokens.high),
                    left: shortTokens(t, f, quotaLeft ?? 0),
                    quota: shortTokens(t, f, quota),
                  })}
                </Paragraph>
                <Paragraph>{t('batchWizard.quotaRule')}</Paragraph>
              </Alert>
            ) : null}
            <div className="batch-box stack-sm">
              <Heading level={4} data-size="2xs">
                {t('batchWizard.overview')}
              </Heading>
              {busy && !estimate ? (
                <p className="meta" role="status">
                  {t('batchWizard.calculating')}
                </p>
              ) : null}
              {estimateError ? (
                <Alert data-color="danger" data-size="sm">
                  {estimateError}
                </Alert>
              ) : null}
              {estimate ? (
                <>
                  <Paragraph data-size="sm" className="meta" data-testid="estimate-basis">
                    {estimate.basis === 'measured'
                      ? `${t('batchWizard.basisMeasured', { count: estimate.samples.filter((s) => !s.error).length })}${
                          estimate.priced
                            ? t('batchWizard.basisMeasuredCost', {
                                cost: kroner(
                                  t,
                                  f,
                                  estimate.samples.reduce(
                                    (sum, s) => sum + (s.costMicroNok ?? 0),
                                    0,
                                  ),
                                ),
                              })
                            : ''
                        }`
                      : t('batchWizard.basisAssumed')}
                  </Paragraph>
                  {estimate.samples
                    .filter((s) => s.error)
                    .map((s) => (
                      <Alert key={s.document} data-color="warning" data-size="sm">
                        {t('batchWizard.sampleFailed', {
                          title:
                            estimate.preview.find((d) => d.id === s.document)?.title ?? s.document,
                          error: s.error ?? '',
                        })}
                      </Alert>
                    ))}
                  {estimate.priced ? (
                    <dl className="batch-tiles">
                      <div>
                        <dt>{t('batchWizard.tokensPerDocument')}</dt>
                        <dd>
                          {t('batchWizard.about', { value: f.number(tokensPerItem(estimate)) })}
                        </dd>
                        <dd className="sub">
                          {estimate.basis === 'measured'
                            ? t('batchWizard.averageOf', {
                                count: estimate.samples.filter((s) => !s.error).length,
                              })
                            : t('batchWizard.assumed')}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('batchWizard.model')}</dt>
                        <dd>{estimate.model ?? t('batchWizard.unknownModel')}</dd>
                        <dd className="sub">
                          {t('batchWizard.serviceVersion', { version: estimate.version })}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('batchWizard.cost')}</dt>
                        <dd>{t('batchWizard.about', { value: costRange(t, f, estimate) })}</dd>
                        <dd className="sub">
                          {t('batchWizard.forDocuments', { count: estimate.items })}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('batchWizard.answerPerDocument')}</dt>
                        <dd>
                          {t('batchWizard.atMostTokens', { count: estimate.maxOutputTokens })}
                        </dd>
                        <dd className="sub">{t('batchWizard.truncatedLonger')}</dd>
                      </div>
                    </dl>
                  ) : (
                    <>
                      <Alert data-color="warning" data-size="sm">
                        <Paragraph data-size="sm">
                          <strong>{t('batchWizard.unpricedHeading')}</strong>{' '}
                          {t('batchWizard.unpricedBody', { model: estimate.model ?? '' })}
                        </Paragraph>
                        <Paragraph data-size="sm">
                          {t('batchWizard.unpricedTotals', {
                            perItem: f.number(tokensPerItem(estimate)),
                            total: shortTokens(t, f, estimate.tokens.high),
                            max: f.number(estimate.maxOutputTokens),
                          })}
                        </Paragraph>
                      </Alert>
                      <Textfield
                        multiline
                        rows={2}
                        label={t('batchWizard.unpricedWhy')}
                        description={t('batchWizard.reasonHint')}
                        value={unpricedWhy}
                        error={unpricedError || undefined}
                        onChange={(e) => {
                          setUnpricedWhy(e.target.value);
                          setUnpricedError('');
                        }}
                      />
                    </>
                  )}
                  {estimate.basis === 'assumed' && estimate.items > 3 ? (
                    <div className="actions">
                      <Button
                        variant="secondary"
                        data-size="sm"
                        aria-disabled={busy || undefined}
                        onClick={() => !busy && void measure(true)}
                      >
                        {t('batchWizard.measureSample')}
                      </Button>
                      <span className="small">
                        {estimate.perItem.costMicroNok
                          ? t('batchWizard.sampleCostMax', {
                              cost: kroner(t, f, estimate.perItem.costMicroNok.high * 3),
                            })
                          : t('batchWizard.sampleCost')}
                      </span>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
            {estimate ? (
              <Textfield
                className="batch-cap"
                label={estimate.priced ? t('batchWizard.stopIfCost') : t('batchWizard.stopIfUse')}
                description={
                  estimate.priced ? t('batchWizard.stopHintCost') : t('batchWizard.stopHintTokens')
                }
                inputMode="decimal"
                value={cap}
                error={capError || undefined}
                onChange={(e) => {
                  setCap(e.target.value);
                  setCapError('');
                }}
              />
            ) : null}
            {needsApproval && estimate?.approval ? (
              <Alert data-color="warning">
                <Heading level={4} data-size="2xs">
                  {t('batchWizard.approvalHeading')}
                </Heading>
                <Paragraph>
                  {t('batchWizard.approvalBody', { limit: estimate.approval.limitNok })}
                </Paragraph>
                <Paragraph className="tag-row">
                  <Tag data-color="warning" data-size="sm">
                    {t('batchWizard.undecided')}
                  </Tag>
                  {t('batchWizard.approvalWho')}
                </Paragraph>
                <Textfield
                  multiline
                  rows={2}
                  label={t('batchWizard.approvalWhy')}
                  description={t('batchWizard.reasonHint')}
                  value={approvalWhy}
                  error={approvalError || undefined}
                  onChange={(e) => {
                    setApprovalWhy(e.target.value);
                    setApprovalError('');
                  }}
                />
              </Alert>
            ) : null}
            <ApiCall line={`POST ${base}/estimate`} body={{ ...filterBody, sample: true }} />
          </section>
        ) : null}

        {step === 4 && estimate ? (
          <section aria-labelledby="batch-s4-h" className="stack batch-narrow">
            <Heading level={3} data-size="sm" id="batch-s4-h">
              {t('batchWizard.stepStart')}
            </Heading>
            <dl className="batch-summary">
              <dt>{t('batchWizard.summaryDocuments')}</dt>
              <dd>
                {t('batchWizard.summaryDocumentsValue', {
                  count: estimate.items,
                  dataset: sources.find((s) => s.id === dataset)?.name ?? dataset,
                })}
              </dd>
              <dt>{t('batchWizard.summarySelection')}</dt>
              <dd>{selectionName(t, { dataset, filters }, sources)}</dd>
              <dt>{t('batchWizard.summaryInput')}</dt>
              <dd>
                {[
                  ...filledValues(inputFields, values).map((v) => `${v.label}: ${v.value}`),
                  ...(prompt.trim() ? [prompt.trim()] : []),
                ].join(' · ') || t('batchWizard.none')}
              </dd>
              <dt>{t('batchWizard.summaryCost')}</dt>
              <dd>
                {estimate.priced
                  ? t('batchWizard.about', { value: costRange(t, f, estimate) })
                  : t('batchWizard.notPriced')}
              </dd>
              <dt>{t('batchWizard.summaryStops')}</dt>
              <dd>
                {estimate.priced
                  ? kroner(t, f, Number(cap.replace(',', '.')) * 1_000_000)
                  : t('batchWizard.summaryTokens', { count: Number(cap) })}
              </dd>
              {needsApproval ? (
                <>
                  <dt>{t('batchWizard.summaryApproval')}</dt>
                  <dd>{approvalWhy.trim()}</dd>
                </>
              ) : null}
            </dl>
            <ApiCall
              line={`POST ${base}`}
              body={{
                estimate: estimate.id,
                ...(estimate.priced
                  ? { maxCostNok: Number(cap.replace(',', '.')) }
                  : { maxTokens: Number(cap) }),
                ...(needsApproval ? { approval: approvalWhy.trim() } : {}),
              }}
            />
          </section>
        ) : null}

        {error ? (
          <Alert data-color="danger" data-size="sm" role="alert">
            {error}
          </Alert>
        ) : null}
        <div className="actions batch-wizard-actions">
          {step > 1 ? (
            <Button variant="secondary" onClick={() => setStep((s) => s - 1)}>
              {t('batchWizard.back')}
            </Button>
          ) : null}
          <Button aria-disabled={nextBlocked || undefined} onClick={next}>
            {step === 4
              ? needsApproval
                ? t('batchWizard.approveAndStart')
                : t('batchWizard.startJob')
              : t('batchWizard.next')}
          </Button>
          <Button variant="tertiary" onClick={onCancel}>
            {t('batchWizard.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
};
