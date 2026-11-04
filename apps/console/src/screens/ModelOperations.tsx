import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Heading,
  Label,
  Link,
  Paragraph,
  Select,
  SelectOption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { stringify as toYamlText } from 'yaml';
import { ApiError, type ApiClient } from '../api';
import { ApiCall } from '../api-call';
import {
  documentId,
  fixtureName,
  formFields,
  formValues,
  inputOf,
  maturityLabel,
  mediaIn,
  nextStep,
  nextStepLabel,
  statusColor,
  statusLabel,
  statusMeaning,
  uploadErrors,
  withoutMediaPaths,
  type FieldProblem,
  type FormField,
  type UploadField,
} from '../descriptors';
import { useAsync } from '../hooks';
import { useT, type PlainKey, type T } from '../i18n';
import { offeredOperations, operationName } from '../model-operations';
import { minimumReasonLength } from '../reason';
import { EmptyState, ErrorState, Loading } from '../states';
import { useTenantNames } from '../tenant-names';
import type {
  DescriptorDetail,
  Maturity,
  OperationDescriptor,
  OperationKind,
  OperationTryResult,
  OperatorModel,
} from '../types';
import {
  DialogError,
  Flash,
  formatWhen,
  PageHeader,
  ReasonDialog,
  SidePanel,
  TableRegion,
  useFlash,
  VisuallyHidden,
} from '../ui';

const problemOf: Record<FieldProblem, PlainKey> = {
  required: 'modelOperations.fieldRequired',
  number: 'modelOperations.fieldNumber',
  json: 'modelOperations.fieldJson',
  choice: 'modelOperations.fieldChoice',
};

const messagesOf = (error: unknown) =>
  error instanceof ApiError ? (error.problem?.errors ?? []).map((e) => e.message) : [];

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="stack-sm">
    <Heading level={3} data-size="2xs">
      {title}
    </Heading>
    {children}
  </div>
);

const StatusTag = ({ status }: { status: OperationDescriptor['status'] }) => {
  const t = useT();
  return (
    <Tag data-size="sm" data-color={statusColor[status]}>
      {t(statusLabel[status])}
    </Tag>
  );
};

const ContractTag = ({ d }: { d: OperationDescriptor }) => {
  const t = useT();
  if (!d.contract)
    return (
      <Tag data-size="sm" data-color="neutral">
        {t('modelOperations.contractNone')}
      </Tag>
    );
  return (
    <Tag data-size="sm" data-color={d.contract.passed ? 'success' : 'danger'}>
      {d.contract.passed
        ? t('modelOperations.contractPassed')
        : t('modelOperations.contractFailed')}
    </Tag>
  );
};

const ReasonInput = ({
  value,
  error,
  onChange,
}: {
  value: string;
  error?: string | undefined;
  onChange: (value: string) => void;
}) => {
  const t = useT();
  const id = useId();
  return (
    <div className="field">
      <Label htmlFor={id}>{t('common.reason')}</Label>
      <Textarea
        id={id}
        rows={2}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <ValidationMessage>{error}</ValidationMessage> : null}
    </div>
  );
};

const reasonProblem = (reason: string, t: ReturnType<typeof useT>) =>
  reason.trim().length < minimumReasonLength
    ? t('common.reasonTooShortAudited', { min: minimumReasonLength })
    : undefined;

export const UploadDialog = ({
  api,
  open,
  replacing,
  onClose,
  onUploaded,
}: {
  api: ApiClient;
  open: boolean;
  replacing?: DescriptorDetail | undefined;
  onClose: () => void;
  onUploaded: (id: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [id, setId] = useState('');
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Partial<Record<UploadField, string[]>>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setId(replacing?.id ?? '');
    setText(replacing?.document ? toYamlText(replacing.document) : '');
    setReason('');
    setErrors({});
  }, [open, replacing]);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    const content = await file.text();
    setText(content);
    if (!replacing) setId(documentId(content) ?? id);
  };

  const upload = async () => {
    const local: Partial<Record<UploadField, string[]>> = {};
    if (!id.trim()) local.id = [t('modelOperations.uploadIdMissing')];
    if (!text.trim()) local.descriptor = [t('modelOperations.uploadTextMissing')];
    const short = reasonProblem(reason, t);
    if (short) local.reason = [short];
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      await api.uploadDescriptor(
        id.trim(),
        {
          descriptor: text,
          ...(replacing?.fixtureCases?.length ? { fixtures: replacing.fixtureCases } : {}),
        },
        reason.trim(),
      );
      onUploaded(id.trim());
    } catch (error) {
      const placed = uploadErrors(error);
      setErrors(
        Object.keys(placed).length
          ? placed
          : { general: [tRef.current('modelOperations.uploadFailed')] },
      );
    } finally {
      setBusy(false);
    }
  };

  const list = (field: UploadField) =>
    (errors[field] ?? []).map((e) => <ValidationMessage key={e}>{e}</ValidationMessage>);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      closeButton={t('common.close')}
      aria-labelledby="upload-h"
      className="reason-dialog"
    >
      {open ? (
        <div className="stack">
          <Heading level={2} data-size="xs" id="upload-h">
            {replacing
              ? t('modelOperations.replaceTitle', { id: replacing.id })
              : t('modelOperations.uploadTitle')}
          </Heading>
          <Paragraph data-size="sm">{t('modelOperations.uploadIntro')}</Paragraph>
          <div className="field">
            <Label htmlFor="upload-file">{t('modelOperations.uploadFile')}</Label>
            <input
              id="upload-file"
              type="file"
              accept=".yaml,.yml,.json,application/json,text/yaml"
              onChange={(e) => void readFile(e.target.files?.[0])}
            />
          </div>
          <div className="field">
            <Label htmlFor="upload-text">{t('modelOperations.uploadText')}</Label>
            <Textarea
              id="upload-text"
              rows={12}
              value={text}
              aria-invalid={errors.descriptor ? true : undefined}
              onChange={(e) => {
                setText(e.target.value);
                if (!replacing && !id) setId(documentId(e.target.value) ?? '');
              }}
            />
            {list('descriptor')}
          </div>
          <Textfield
            label={t('modelOperations.uploadId')}
            description={t('modelOperations.uploadIdHint')}
            value={id}
            readOnly={Boolean(replacing)}
            onChange={(e) => setId(e.target.value.trim())}
            error={errors.id?.join(' ')}
          />
          {replacing?.fixtureCases?.length ? (
            <div className="stack-sm">
              <Paragraph data-size="sm">
                {t('modelOperations.replaceKeepsFixtures', {
                  count: replacing.fixtureCases.length,
                })}
              </Paragraph>
              {list('fixtures')}
            </div>
          ) : errors.fixtures ? (
            <div className="stack-sm">{list('fixtures')}</div>
          ) : null}
          <ReasonInput value={reason} error={errors.reason?.join(' ')} onChange={setReason} />
          {errors.general ? (
            <Alert data-color="danger" role="alert">
              {errors.general.join(' ')}
            </Alert>
          ) : null}
          <ApiCall
            method="PUT"
            path={`/operator/operation-descriptors/${id || '<id>'}`}
            body={{ descriptor: '…', fixtures: [] }}
          />
          <div className="actions-row">
            <Button loading={busy} onClick={() => void upload()}>
              {t('modelOperations.uploadAndCheck')}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
};

const FieldInput = ({
  field,
  value,
  problem,
  onChange,
}: {
  field: FormField;
  value: string;
  problem: FieldProblem | undefined;
  onChange: (value: string) => void;
}) => {
  const t = useT();
  const id = useId();
  const label = field.optional
    ? t('modelOperations.optionalField', { name: field.name })
    : field.name;
  const error = problem ? t(problemOf[problem]) : undefined;
  if (field.kind === 'yes-no')
    return (
      <Checkbox
        label={label}
        checked={value === 'true'}
        onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
      />
    );
  if (field.kind === 'choice')
    return (
      <div className="field">
        <Label htmlFor={id}>{label}</Label>
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <SelectOption value="">{t('modelOperations.choose')}</SelectOption>
          {(field.values ?? []).map((v) => (
            <SelectOption key={v} value={v}>
              {v}
            </SelectOption>
          ))}
        </Select>
        {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      </div>
    );
  if (field.kind === 'line' || field.kind === 'number')
    return (
      <Textfield
        label={label}
        value={value}
        {...(field.kind === 'number' ? { inputMode: 'decimal' as const } : {})}
        onChange={(e) => onChange(e.target.value)}
        error={error}
      />
    );
  const hint =
    field.kind === 'lines'
      ? t('modelOperations.linesHint')
      : field.kind === 'json'
        ? t('modelOperations.jsonHint')
        : undefined;
  return (
    <div className="field">
      <Label htmlFor={id}>{label}</Label>
      {hint ? (
        <Paragraph data-size="sm" className="muted">
          {hint}
        </Paragraph>
      ) : null}
      <Textarea
        id={id}
        rows={field.kind === 'json' ? 6 : 3}
        value={value}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <ValidationMessage>{error}</ValidationMessage> : null}
    </div>
  );
};

const fixtureFile = (tried: OperationTryResult) =>
  `data:application/json;charset=utf-8,${encodeURIComponent(
    JSON.stringify(
      {
        source: `recorded from the synthetic try ${tried.task}`,
        ...tried.exchange,
      },
      null,
      2,
    ),
  )}`;

const TrySection = ({
  api,
  detail,
  models,
  onRecorded,
}: {
  api: ApiClient;
  detail: DescriptorDetail;
  models: OperatorModel[];
  onRecorded: (name: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const f = useFormat();
  const offering = models.filter((m) => offeredOperations(m).includes(detail.operation));
  const fields = formFields(detail.input);
  const [model, setModel] = useState(offering[0]?.id ?? '');
  const [values, setValues] = useState(() => formValues(fields, detail.fixtureCases?.[0]?.input));
  const [problems, setProblems] = useState<Record<string, FieldProblem>>({});
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ lead: string; details: string[] } | undefined>();
  const [tried, setTried] = useState<OperationTryResult | undefined>();
  const [name, setName] = useState(`try-${(detail.fixtures ?? 0) + 1}`);
  const [nameError, setNameError] = useState<string | undefined>();
  const [recording, setRecording] = useState(false);
  const canRecord = detail.source === 'uploaded' && detail.status === 'review';

  if (offering.length === 0)
    return (
      <Paragraph data-size="sm">
        {t.rich('modelOperations.tryNoModel', {
          kind: operationName(detail.operation, t),
          link: (c) => <Link href="#/models">{c}</Link>,
        })}
      </Paragraph>
    );

  const run = async () => {
    setFailed(undefined);
    const built = inputOf(fields, values);
    const short = reasonProblem(reason, t);
    setReasonError(short);
    setProblems('problems' in built ? built.problems : {});
    if ('problems' in built || short) return;
    setBusy(true);
    setTried(undefined);
    try {
      setTried(await api.tryOperation(detail.id, model, built.input, reason.trim()));
    } catch (error) {
      setFailed({ lead: tRef.current('modelOperations.tryFailed'), details: messagesOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const record = async () => {
    if (!tried?.exchange) return;
    if (!fixtureName.test(name)) {
      setNameError(t('modelOperations.fixtureNameHint'));
      return;
    }
    const short = reasonProblem(reason, t);
    setReasonError(short);
    if (short) return;
    setNameError(undefined);
    setRecording(true);
    try {
      await api.recordFixture(
        detail.id,
        { task: tried.task, name, exchange: tried.exchange },
        reason.trim(),
      );
      onRecorded(name);
    } catch (error) {
      const named =
        error instanceof ApiError &&
        error.problem?.errors?.some((e) => e.path === 'name') &&
        messagesOf(error).join(' ');
      if (named) setNameError(named);
      else
        setFailed({
          lead: tRef.current('modelOperations.recordFailed'),
          details: messagesOf(error),
        });
    } finally {
      setRecording(false);
    }
  };

  const media = tried?.exchange ? mediaIn(tried.result, tried.exchange.result) : [];

  return (
    <div className="stack">
      <Alert data-color="info" data-size="sm">
        {t('modelOperations.trySynthetic')}
      </Alert>
      <div className="field">
        <Label htmlFor="try-model">{t('modelOperations.tryModel')}</Label>
        <Select id="try-model" value={model} onChange={(e) => setModel(e.target.value)}>
          {offering.map((m) => (
            <SelectOption key={m.id} value={m.id}>
              {m.deployment} ({m.endpoint})
            </SelectOption>
          ))}
        </Select>
      </div>
      {fields.map((field) => {
        const key = field.path.join('.');
        return (
          <FieldInput
            key={key || 'input'}
            field={field}
            value={values[key] ?? ''}
            problem={problems[key]}
            onChange={(v) => setValues((all) => ({ ...all, [key]: v }))}
          />
        );
      })}
      <ReasonInput value={reason} error={reasonError} onChange={setReason} />
      <div className="actions-row">
        <Button variant="secondary" loading={busy} onClick={() => void run()}>
          {t('modelOperations.tryRun')}
        </Button>
      </div>
      {failed ? (
        <Alert data-color="danger" role="alert">
          <Paragraph>{failed.lead}</Paragraph>
          {failed.details.length ? (
            <ul>
              {failed.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
      {tried ? (
        <div className="stack" aria-live="polite">
          {tried.exchange ? (
            <Section title={t('modelOperations.trySent')}>
              <Paragraph data-size="sm">{t('modelOperations.trySentHint')}</Paragraph>
              <code className="api-line">{`${tried.exchange.request.method} ${tried.exchange.request.path}`}</code>
              <pre className="code">{JSON.stringify(tried.exchange.request.body, null, 2)}</pre>
            </Section>
          ) : null}
          <Section title={t('modelOperations.tryAnswer')}>
            <pre className="code">{JSON.stringify(withoutMediaPaths(tried.result), null, 2)}</pre>
            {tried.exchange ? (
              <Paragraph data-size="sm">
                {t('modelOperations.tryUsage', {
                  input: f.number(tried.exchange.usage.inputTokens ?? 0),
                  output: f.number(tried.exchange.usage.outputTokens ?? 0),
                })}
              </Paragraph>
            ) : null}
          </Section>
          {media.length ? (
            <Section title={t('modelOperations.tryMedia')}>
              <ul className="plain stack-sm">
                {media.map((m) => (
                  <li key={m.path} className="stack-sm">
                    <span className="meta">
                      {t('modelOperations.mediaLine', {
                        type: m.mediaType,
                        size: f.number(m.bytes),
                      })}
                    </span>
                    {m.mediaType.startsWith('image/') ? (
                      <img
                        className="try-media"
                        src={m.src}
                        alt={t('modelOperations.mediaAlt', { field: m.path })}
                      />
                    ) : (
                      <Link href={m.src} download={`${m.path || 'media'}`}>
                        {t('modelOperations.mediaDownload', { field: m.path })}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {tried.exchange ? (
            <Section title={t('modelOperations.recordTitle')}>
              {canRecord ? (
                <>
                  <Paragraph data-size="sm">{t('modelOperations.recordIntro')}</Paragraph>
                  <Textfield
                    label={t('modelOperations.fixtureName')}
                    description={t('modelOperations.fixtureNameHint')}
                    value={name}
                    onChange={(e) => setName(e.target.value.trim())}
                    error={nameError}
                  />
                  <div className="actions-row">
                    <Button loading={recording} onClick={() => void record()}>
                      {t('modelOperations.recordSave')}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <Paragraph data-size="sm">{t('modelOperations.recordBundled')}</Paragraph>
                  <Link href={fixtureFile(tried)} download={`${name}.json`}>
                    {t('modelOperations.recordDownload')}
                  </Link>
                </>
              )}
            </Section>
          ) : null}
        </div>
      ) : null}
      <ApiCall
        method="POST"
        path={`/operator/operations/${detail.id}/try`}
        body={{ model, input: '…', synthetic: true }}
      />
    </div>
  );
};

type Decision = 'described' | 'review' | 'withdraw';

const DescriptorPanel = ({
  api,
  id,
  environment,
  kind,
  models,
  onClose,
  onDecide,
  onReplace,
  onChanged,
}: {
  api: ApiClient;
  id: string;
  environment: Maturity | undefined;
  kind: OperationKind | undefined;
  models: OperatorModel[];
  onClose: () => void;
  onDecide: (detail: DescriptorDetail, decision: Decision) => void;
  onReplace: (detail: DescriptorDetail) => void;
  onChanged: (message: string) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [state, reload] = useAsync((signal) => api.operationDescriptor(id, signal), [api, id]);
  const detail = state.status === 'ready' ? state.data : undefined;
  const next = detail ? nextStep(detail, kind) : undefined;
  const uploaded = detail?.source === 'uploaded';
  return (
    <SidePanel labelledBy="descriptor-panel-h" onClose={onClose}>
      <div className="panel-head">
        <span className="eyebrow">
          {detail ? operationName(detail.operation, t) : t('modelOperations.title')}
        </span>
        <Heading level={2} data-size="sm" id="descriptor-panel-h" tabIndex={-1}>
          {id}
        </Heading>
      </div>
      <div className="panel-body">
        {state.status === 'loading' ? <Loading label={t('modelOperations.loadingOne')} /> : null}
        {state.status === 'error' ? <ErrorState error={state.error} onRetry={reload} /> : null}
        {detail && next ? (
          <>
            {detail.summary ? <Paragraph>{detail.summary}</Paragraph> : null}
            <div className="stack-sm">
              <span className="name-line">
                <StatusTag status={detail.status} />
                <ContractTag d={detail} />
              </span>
              <Paragraph data-size="sm">{t(statusMeaning[detail.status])}</Paragraph>
            </div>
            <Alert data-color={next === 'fix' ? 'warning' : 'info'} data-size="sm">
              <strong>{t('modelOperations.nextLabel')}</strong> {t(nextStepLabel[next])}
            </Alert>
            <dl className="def-list">
              <dt>{t('modelOperations.kind')}</dt>
              <dd>
                {operationName(detail.operation, t)}
                {kind && !kind.builtIn ? ` · ${t(maturityLabel[kind.maturity])}` : ''}
              </dd>
              <dt>{t('modelOperations.source')}</dt>
              <dd>
                {uploaded
                  ? t('modelOperations.sourceUploaded')
                  : t('modelOperations.sourceBundled')}
              </dd>
              <dt>{t('modelOperations.protocol')}</dt>
              <dd>{detail.protocol ?? t('modelOperations.unknown')}</dd>
              {detail.by && detail.at ? (
                <>
                  <dt>{t('modelOperations.lastChange')}</dt>
                  <dd>
                    {t('modelOperations.lastChangeLine', {
                      who: detail.by,
                      when: formatWhen(detail.at, f, t),
                    })}
                    {detail.reason ? (
                      <>
                        <br />
                        <span className="muted">{detail.reason}</span>
                      </>
                    ) : null}
                  </dd>
                </>
              ) : null}
            </dl>
            {detail.problems?.length ? (
              <Alert data-color="danger" data-size="sm">
                {detail.problems.join(' ')}
              </Alert>
            ) : null}
            <Section
              title={t('modelOperations.contractTitle', {
                count: detail.fixtures,
              })}
            >
              {detail.contract === null ? (
                <Paragraph data-size="sm">{t('modelOperations.contractNoneText')}</Paragraph>
              ) : detail.contract.passed ? (
                <Paragraph data-size="sm">
                  {t('modelOperations.contractPassedText', { checks: detail.contract.checks })}
                </Paragraph>
              ) : (
                <ul className="plain check-list">
                  {detail.contract.failures.map((x) => (
                    <li key={x.check}>
                      <span className="two-line">
                        <span>{x.check}</span>
                        {x.problems.map((p) => (
                          <span key={p} className="meta">
                            {p}
                          </span>
                        ))}
                      </span>
                      <Tag data-size="sm" data-color="danger">
                        {t('modelOperations.contractFailed')}
                      </Tag>
                    </li>
                  ))}
                </ul>
              )}
              {detail.fixtureCases?.length ? (
                <ul className="plain">
                  {detail.fixtureCases.map((c) => (
                    <li key={c.name}>
                      <strong>{c.name}</strong>
                      {c.source ? <span className="meta"> · {c.source}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>
            <Section title={t('modelOperations.tryTitle')}>
              {environment === 'test' ? (
                <TrySection
                  key={detail.fixtures}
                  api={api}
                  detail={detail}
                  models={models}
                  onRecorded={(name) => {
                    onChanged(t('modelOperations.recorded', { name, id: detail.id }));
                    reload();
                  }}
                />
              ) : (
                <Paragraph data-size="sm">{t('modelOperations.tryOnlyInTest')}</Paragraph>
              )}
            </Section>
            {uploaded && detail.status === 'review' ? (
              <Paragraph data-size="sm">
                <strong>{t('modelOperations.whenApproving')}</strong>{' '}
                {t('modelOperations.whenApprovingText')}
              </Paragraph>
            ) : null}
            {!uploaded ? (
              <Paragraph data-size="sm">{t('modelOperations.bundledNote')}</Paragraph>
            ) : null}
          </>
        ) : null}
      </div>
      {detail && uploaded ? (
        <div className="panel-foot actions-row">
          {detail.status === 'review' ? (
            <>
              <Button
                disabled={!detail.contract?.passed}
                onClick={() => onDecide(detail, 'described')}
              >
                {t('modelOperations.approve')}
              </Button>
              <Button variant="secondary" onClick={() => onReplace(detail)}>
                {t('modelOperations.replace')}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => onDecide(detail, 'review')}>
              {t('modelOperations.backToReview')}
            </Button>
          )}
          <Button
            variant="secondary"
            data-color="danger"
            onClick={() => onDecide(detail, 'withdraw')}
          >
            {t('modelOperations.withdraw')}
          </Button>
        </div>
      ) : null}
    </SidePanel>
  );
};

const decisionTitle: Record<Decision, (id: string, t: T) => string> = {
  described: (id, t) => t('modelOperations.approveTitle', { id }),
  review: (id, t) => t('modelOperations.backToReviewTitle', { id }),
  withdraw: (id, t) => t('modelOperations.withdrawTitle', { id }),
};

const decisionText: Record<Decision, { text: PlainKey; cta: PlainKey }> = {
  described: {
    text: 'modelOperations.approveText',
    cta: 'modelOperations.approve',
  },
  review: {
    text: 'modelOperations.backToReviewText',
    cta: 'modelOperations.backToReview',
  },
  withdraw: {
    text: 'modelOperations.withdrawText',
    cta: 'modelOperations.withdraw',
  },
};

const howSteps: PlainKey[] = [
  'modelOperations.how1',
  'modelOperations.how2',
  'modelOperations.how3',
  'modelOperations.how4',
  'modelOperations.how5',
];

export const ModelOperations = ({ api }: { api: ApiClient }) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [descriptors, reloadDescriptors] = useAsync(
    (signal) => api.operationDescriptors(signal),
    [api],
  );
  const [kinds, reloadKinds] = useAsync((signal) => api.operationKindsOverview(signal), [api]);
  const [models] = useAsync((signal) => api.listModels(signal), [api]);
  const [open, setOpen] = useState<string | undefined>();
  const [panelKey, setPanelKey] = useState(0);
  const [uploading, setUploading] = useState<{ replacing?: DescriptorDetail } | undefined>();
  const [deciding, setDeciding] = useState<
    { detail: DescriptorDetail; decision: Decision } | undefined
  >();
  const [moving, setMoving] = useState<OperationKind | undefined>();
  const flash = useFlash();
  const tenantName = useTenantNames(api);
  const kindList = kinds.status === 'ready' ? kinds.data.data : [];
  const environment = kinds.status === 'ready' ? kinds.data.environment : undefined;
  const kindOf = (operation: string) => kindList.find((k) => k.kind === operation);
  const reload = () => {
    reloadDescriptors();
    reloadKinds();
  };

  const decide = async (why: string) => {
    if (!deciding) return;
    const { detail, decision } = deciding;
    try {
      if (decision === 'withdraw') await api.withdrawDescriptor(detail.id, why);
      else await api.setDescriptorStatus(detail.id, decision, why);
    } catch (error) {
      throw new DialogError(
        [tRef.current('modelOperations.decideFailed'), ...messagesOf(error)].join(' '),
      );
    }
    flash.show(
      tRef.current(
        decision === 'withdraw'
          ? 'modelOperations.withdrawn'
          : decision === 'described'
            ? 'modelOperations.approved'
            : 'modelOperations.movedBack',
        { id: detail.id },
      ),
    );
    if (decision === 'withdraw') setOpen(undefined);
    else setPanelKey((k) => k + 1);
    reload();
  };

  const move = async (why: string) => {
    if (!moving) return;
    const to: Maturity = moving.maturity === 'test' ? 'production' : 'test';
    try {
      await api.setKindMaturity(moving.kind, to, why);
    } catch (error) {
      throw new DialogError(
        [tRef.current('modelOperations.decideFailed'), ...messagesOf(error)].join(' '),
      );
    }
    flash.show(
      tRef.current(to === 'production' ? 'modelOperations.promoted' : 'modelOperations.demoted', {
        kind: operationName(moving.kind, tRef.current),
      }),
    );
    reloadKinds();
  };

  return (
    <>
      <div className="page-head-row">
        <PageHeader
          eyebrow={t('shell.groupPlatform')}
          title={t('modelOperations.title')}
          intro={t('modelOperations.intro')}
        />
        <Button variant="secondary" onClick={() => setUploading({})}>
          {t('modelOperations.uploadTitle')}
        </Button>
      </div>
      <Flash message={flash.message} />
      <div className="callout">
        <span className="two-line">
          <span className="label-strong">{t('modelOperations.howTitle')}</span>
          <ol>
            {howSteps.map((s) => (
              <li key={s}>{t(s)}</li>
            ))}
          </ol>
          {environment ? (
            <span>
              {environment === 'test'
                ? t('modelOperations.environmentTest')
                : t('modelOperations.environmentProduction')}
            </span>
          ) : null}
        </span>
      </div>
      <section className="stack" aria-labelledby="descriptors-h">
        <Heading level={2} data-size="xs" id="descriptors-h">
          {t('modelOperations.descriptorsTitle')}
        </Heading>
        {descriptors.status === 'loading' ? <Loading label={t('modelOperations.loading')} /> : null}
        {descriptors.status === 'error' ? (
          <ErrorState error={descriptors.error} onRetry={reloadDescriptors} />
        ) : null}
        {descriptors.status === 'ready' && descriptors.data.length === 0 ? (
          <EmptyState title={t('modelOperations.noneTitle')}>
            <Paragraph>{t('modelOperations.noneText')}</Paragraph>
          </EmptyState>
        ) : null}
        {descriptors.status === 'ready' && descriptors.data.length > 0 ? (
          <TableRegion label={t('modelOperations.descriptorsTitle')}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">
                    {t('modelOperations.colDescriptor')}
                  </TableHeaderCell>
                  <TableHeaderCell scope="col">{t('modelOperations.colKind')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('modelOperations.colStatus')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('modelOperations.colFixtures')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('modelOperations.colContract')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('modelOperations.colNext')}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {descriptors.data.map((d) => {
                  const next = nextStep(d, kindOf(d.operation));
                  return (
                    <TableRow key={d.id}>
                      <TableHeaderCell scope="row">
                        <span className="two-line">
                          <strong>{d.id}</strong>
                          <span className="meta">
                            {d.source === 'uploaded'
                              ? t('modelOperations.sourceUploaded')
                              : t('modelOperations.sourceBundled')}
                            {d.summary ? ` · ${d.summary}` : ''}
                          </span>
                        </span>
                      </TableHeaderCell>
                      <TableCell>{operationName(d.operation, t)}</TableCell>
                      <TableCell>
                        <span className="two-line">
                          <StatusTag status={d.status} />
                          <span className="meta">{t(statusMeaning[d.status])}</span>
                        </span>
                      </TableCell>
                      <TableCell>{d.fixtures}</TableCell>
                      <TableCell>
                        <ContractTag d={d} />
                      </TableCell>
                      <TableCell>
                        <span className="two-line">
                          <span className="sm">{t(nextStepLabel[next])}</span>
                          <Button
                            variant="tertiary"
                            data-size="sm"
                            className="align-start"
                            aria-label={t('modelOperations.openFor', { id: d.id })}
                            onClick={() => setOpen(d.id)}
                          >
                            {t('modelOperations.open')}
                          </Button>
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableRegion>
        ) : null}
      </section>
      <section className="stack" aria-labelledby="kinds-h">
        <Heading level={2} data-size="xs" id="kinds-h">
          {t('modelOperations.kindsTitle')}
        </Heading>
        <Paragraph data-size="sm">{t('modelOperations.kindsIntro')}</Paragraph>
        {kinds.status === 'loading' ? <Loading label={t('modelOperations.loadingKinds')} /> : null}
        {kinds.status === 'error' ? <ErrorState error={kinds.error} onRetry={reloadKinds} /> : null}
        {kinds.status === 'ready' ? (
          <TableRegion label={t('modelOperations.kindsTitle')}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell scope="col">{t('modelOperations.colKind')}</TableHeaderCell>
                  <TableHeaderCell scope="col">{t('modelOperations.colMaturity')}</TableHeaderCell>
                  <TableHeaderCell scope="col">
                    {t('modelOperations.colDescriptors')}
                  </TableHeaderCell>
                  <TableHeaderCell scope="col">
                    <VisuallyHidden>{t('modelOperations.colActions')}</VisuallyHidden>
                  </TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {kindList.map((k) => (
                  <TableRow key={k.kind}>
                    <TableHeaderCell scope="row">
                      <span className="two-line">
                        <strong>{operationName(k.kind, t)}</strong>
                        <span className="meta">{k.kind}</span>
                      </span>
                    </TableHeaderCell>
                    <TableCell>
                      <span className="two-line">
                        {k.builtIn ? (
                          <span className="sm">{t('modelOperations.builtInKind')}</span>
                        ) : (
                          <>
                            <Tag
                              data-size="sm"
                              data-color={k.maturity === 'production' ? 'success' : 'warning'}
                            >
                              {t(maturityLabel[k.maturity])}
                            </Tag>
                            <span className="meta">
                              {k.maturity === 'production'
                                ? t('modelOperations.maturityProductionMeaning')
                                : t('modelOperations.maturityTestMeaning')}
                            </span>
                          </>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>{k.descriptors.map((d) => d.id).join(', ') || '–'}</TableCell>
                    <TableCell>
                      {k.builtIn || k.descriptors.length === 0 ? null : (
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          onClick={() => setMoving(k)}
                          aria-label={
                            k.maturity === 'test'
                              ? t('modelOperations.promoteFor', { kind: operationName(k.kind, t) })
                              : t('modelOperations.demoteFor', { kind: operationName(k.kind, t) })
                          }
                        >
                          {k.maturity === 'test'
                            ? t('modelOperations.promote')
                            : t('modelOperations.demote')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableRegion>
        ) : null}
      </section>
      {open ? (
        <DescriptorPanel
          key={`${open}-${panelKey}`}
          api={api}
          id={open}
          environment={environment}
          kind={kindList.find(
            (k) =>
              descriptors.status === 'ready' &&
              k.kind === descriptors.data.find((d) => d.id === open)?.operation,
          )}
          models={models.status === 'ready' ? models.data : []}
          onClose={() => setOpen(undefined)}
          onDecide={(detail, decision) => setDeciding({ detail, decision })}
          onReplace={(detail) => setUploading({ replacing: detail })}
          onChanged={(message) => {
            flash.show(message);
            reload();
          }}
        />
      ) : null}
      <UploadDialog
        api={api}
        open={Boolean(uploading)}
        replacing={uploading?.replacing}
        onClose={() => setUploading(undefined)}
        onUploaded={(id) => {
          setUploading(undefined);
          flash.show(t('modelOperations.uploaded', { id }));
          reload();
          setOpen(id);
          setPanelKey((k) => k + 1);
        }}
      />
      <ReasonDialog
        open={Boolean(deciding)}
        title={deciding ? decisionTitle[deciding.decision](deciding.detail.id, t) : ''}
        text={deciding ? t(decisionText[deciding.decision].text) : undefined}
        confirmLabel={deciding ? t(decisionText[deciding.decision].cta) : ''}
        onClose={() => setDeciding(undefined)}
        onConfirm={decide}
      >
        {deciding && deciding.decision !== 'described' ? (
          <div className="stack-sm">
            <span className="label-strong">
              {t('modelOperations.usedByCount', { count: deciding.detail.usedBy.length })}
            </span>
            {deciding.detail.usedBy.length ? (
              <ul className="service-list">
                {deciding.detail.usedBy.map((u) => (
                  <li key={`${u.tenant}/${u.service}`}>
                    <span>
                      <strong>{u.service}</strong> · {tenantName(u.tenant)}
                    </span>
                    <span className="meta">{t('modelOperations.versionN', { n: u.version })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Paragraph data-size="sm">{t('modelOperations.usedByNone')}</Paragraph>
            )}
          </div>
        ) : null}
      </ReasonDialog>
      <ReasonDialog
        open={Boolean(moving)}
        title={
          !moving
            ? ''
            : moving.maturity === 'test'
              ? t('modelOperations.promoteTitle', { kind: operationName(moving.kind, t) })
              : t('modelOperations.demoteTitle', { kind: operationName(moving.kind, t) })
        }
        text={
          moving
            ? t(
                moving.maturity === 'test'
                  ? 'modelOperations.promoteText'
                  : 'modelOperations.demoteText',
              )
            : undefined
        }
        confirmLabel={
          moving
            ? t(moving.maturity === 'test' ? 'modelOperations.promote' : 'modelOperations.demote')
            : ''
        }
        onClose={() => setMoving(undefined)}
        onConfirm={move}
      />
    </>
  );
};
