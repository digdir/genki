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
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { stringify as toYamlText } from 'yaml';
import { ApiError, type ApiClient } from '../../api';
import { ApiCall } from '../../api-call';
import {
  documentId,
  fixtureName,
  formFields,
  formValues,
  inputOf,
  mediaIn,
  statusColor,
  statusLabel,
  uploadErrors,
  withoutMediaPaths,
  type FieldProblem,
  type FormField,
  type UploadField,
} from '../../descriptors';
import { useT, type PlainKey } from '../../i18n';
import { minimumReasonLength } from '../../reason';
import type {
  DescriptorDetail,
  OperationDescriptor,
  OperationTryResult,
  OperatorModel,
} from '../../types';
import {} from '../../ui';

const problemOf: Record<FieldProblem, PlainKey> = {
  required: 'modelOperations.fieldRequired',
  number: 'modelOperations.fieldNumber',
  json: 'modelOperations.fieldJson',
  choice: 'modelOperations.fieldChoice',
};

export const messagesOf = (error: unknown) =>
  error instanceof ApiError ? (error.problem?.errors ?? []).map((e) => e.message) : [];

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="stack-sm">
    <Heading level={3} data-size="2xs">
      {title}
    </Heading>
    {children}
  </div>
);

export const StatusTag = ({ status }: { status: OperationDescriptor['status'] }) => {
  const t = useT();
  return (
    <Tag data-size="sm" data-color={statusColor[status]}>
      {t(statusLabel[status])}
    </Tag>
  );
};

export const ContractTag = ({ d }: { d: OperationDescriptor }) => {
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

export const TrySection = ({
  api,
  detail,
  model,
  onRecorded,
}: {
  api: ApiClient;
  detail: DescriptorDetail;
  model: OperatorModel;
  onRecorded: (name: string) => void;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const f = useFormat();
  const fields = formFields(detail.input);
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
      setTried(await api.tryOperation(detail.id, model.id, built.input, reason.trim()));
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
        body={{ model: model.id, input: '…', synthetic: true }}
      />
    </div>
  );
};
