import {
  Alert,
  Button,
  Details,
  DetailsContent,
  DetailsSummary,
  ErrorSummary,
  ErrorSummaryHeading,
  ErrorSummaryItem,
  ErrorSummaryLink,
  ErrorSummaryList,
  Field,
  FieldDescription,
  Heading,
  Input,
  Label,
  Select,
  SelectOption,
  Spinner,
  Switch,
  Tag,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import type { ApiClient } from '../../api';
import { useT } from '../../i18n';
import type {
  EndpointTestResult,
  KnowledgeEndpoint,
  KnowledgeEngine,
  StoredSecret,
} from '../../types';
import { formatDay } from '../../ui';
import { ApiCallPanel, type ApiCall } from './ApiCallPanel';
import { capabilityCount, capabilityTotal } from './capabilities';
import {
  fieldsOf,
  formSchemaOf,
  initialValues,
  toSpec,
  validate,
  type FormField,
  type FormValues,
} from './schema-form';
import { reasonProblem } from '../../reason';

interface Props {
  api: ApiClient;
  engines: KnowledgeEngine[];
  secrets: StoredSecret[];
  endpoint?: KnowledgeEndpoint;
  spec?: Record<string, unknown>;
  initial?: { name?: string; engine?: string; values?: FormValues; tried?: boolean };
  onSaved: (name: string) => void;
  onCancel: () => void;
}

const back = 'M15 6l-6 6 6 6';

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const settingsOf = (spec: Record<string, unknown> | undefined) =>
  spec
    ? Object.fromEntries(
        Object.entries(spec).filter(([key]) => key !== 'engine' && key !== 'sharing'),
      )
    : undefined;

const FieldControl = ({
  field,
  value,
  error,
  secrets,
  onChange,
}: {
  field: FormField;
  value: string | boolean | undefined;
  error: string | undefined;
  secrets: StoredSecret[];
  onChange: (value: string | boolean) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const secretLabel = (s: StoredSecret) =>
    s.updatedAt
      ? t('searchEngines.secretUpdated', { name: s.name, date: formatDay(s.updatedAt, f) })
      : s.name;
  const keyLine = (
    <span className="schema-rule">
      {field.key} · {field.rule(t)}
    </span>
  );
  if (field.kind === 'boolean')
    return (
      <div className="schema-field">
        <Switch
          id={field.id}
          label={field.title}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.description ? <span className="schema-desc">{field.description}</span> : null}
        {keyLine}
      </div>
    );
  const label = field.required
    ? field.title
    : t('searchEngines.fieldOptional', { title: field.title });
  const text = typeof value === 'string' ? value : '';
  return (
    <Field className="schema-field">
      <Label>{label}</Label>
      {field.kind === 'secret' || field.kind === 'enum' ? (
        <Select
          id={field.id}
          value={text}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.kind === 'secret' ? (
            <>
              <SelectOption value="">{t('searchEngines.chooseSecret')}</SelectOption>
              {secrets.map((s) => (
                <SelectOption key={s.ref} value={s.ref}>
                  {secretLabel(s)}
                </SelectOption>
              ))}
            </>
          ) : (
            <>
              {field.required ? (
                <SelectOption value="">{t('searchEngines.choose')}</SelectOption>
              ) : null}
              {field.options.map((o) => (
                <SelectOption key={o.value} value={o.value}>
                  {o.label}
                </SelectOption>
              ))}
            </>
          )}
        </Select>
      ) : (
        <Input
          id={field.id}
          type={field.kind === 'url' ? 'url' : 'text'}
          {...(field.kind === 'integer' || field.kind === 'number'
            ? { inputMode: field.kind === 'integer' ? ('numeric' as const) : ('decimal' as const) }
            : {})}
          autoComplete="off"
          value={text}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
      <FieldDescription>{keyLine}</FieldDescription>
      {error ? <ValidationMessage>{error}</ValidationMessage> : null}
    </Field>
  );
};

export const EndpointEditor = ({
  api,
  engines,
  secrets,
  endpoint,
  spec: stored,
  initial,
  onSaved,
  onCancel,
}: Props) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const isNew = !endpoint;
  const firstEngine =
    initial?.engine ??
    endpoint?.engine ??
    (engines.find((e) => !e.builtin) ?? engines[0])?.engine ??
    '';
  const [engineId, setEngineId] = useState(firstEngine);
  const engine = engines.find((e) => e.engine === engineId) as KnowledgeEngine;
  const [name, setName] = useState(initial?.name ?? endpoint?.name ?? '');
  const [values, setValues] = useState<FormValues>(
    () => initial?.values ?? initialValues(engine, settingsOf(stored)),
  );
  const [tried, setTried] = useState(initial?.tried ?? false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<EndpointTestResult | undefined>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [call, setCall] = useState<ApiCall | undefined>();
  const summary = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const [focusSummary, setFocusSummary] = useState(false);

  const schema = formSchemaOf(engine);
  const fields = fieldsOf(schema, values);
  const errors = tried ? validate(fields, values, t) : {};
  const nameError = tried && !name.trim() ? t('searchEngines.nameRequired') : '';
  const errorLinks = [
    ...(nameError
      ? [{ id: 'ep-name', text: t('searchEngines.nameError', { error: nameError }) }]
      : []),
    ...fields
      .filter((f) => errors[f.key])
      .map((f) => ({ id: f.id, text: `${f.title}: ${errors[f.key]}` })),
  ];
  const id = endpoint?.id ?? (slug(name) || 'nytt-endepunkt');
  const spec = {
    ...toSpec(engine, fields, values),
    ...(name.trim() && name.trim() !== id ? { name: name.trim() } : {}),
    ...(stored?.sharing === undefined ? {} : { sharing: stored.sharing }),
  };

  useEffect(() => {
    if (focusSummary && errorLinks.length) {
      summary.current?.focus();
      setFocusSummary(false);
    }
  }, [focusSummary, errorLinks.length]);

  const setValue = (key: string, value: string | boolean) => {
    setValues((v) => ({ ...v, [key]: value }));
    setTest(undefined);
  };

  const pickEngine = (next: KnowledgeEngine) => {
    setEngineId(next.engine);
    setValues(initialValues(next));
    setTried(false);
    setTest(undefined);
  };

  const runTest = async () => {
    setTesting(true);
    setTest(undefined);
    try {
      setTest(await api.testKnowledgeEndpoint(toSpec(engine, fields, values)));
    } catch {
      setTest({ ok: false, message: tRef.current('searchEngines.testNoAnswer'), ms: 0 });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setTried(true);
    const found = validate(fields, values, t);
    if (Object.keys(found).length || !name.trim()) {
      setFocusSummary(true);
      return;
    }
    const tooShort = reasonProblem(t, reason);
    if (tooShort) {
      setReasonError(tooShort);
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      await api.saveKnowledgeEndpoint(id, spec, reason.trim());
      onSaved(name.trim());
    } catch {
      setProblem(tRef.current('searchEngines.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const testTag = test
    ? test.ok
      ? t('searchEngines.testWorks')
      : t('searchEngines.testFailed')
    : '';
  const testText = test
    ? test.ok
      ? t('searchEngines.testAnswered', {
          engine: engine.title,
          ms: test.ms,
          message: test.message,
        })
      : test.message || t('searchEngines.testNoContact')
    : '';

  return (
    <div className="stack endpoint-editor">
      <a
        href="#/search-engines"
        className="ds-link back-link"
        onClick={(e) => {
          e.preventDefault();
          onCancel();
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d={back} />
        </svg>
        {t('searchEngines.title')}
      </a>
      <div className="stack-xs">
        <span className="meta">{t('searchEngines.endpoint')}</span>
        <Heading level={1} data-size="md">
          {isNew ? t('searchEngines.newEndpoint') : endpoint.name}
        </Heading>
      </div>

      {tried && errorLinks.length ? (
        <ErrorSummary ref={summary} tabIndex={-1}>
          <ErrorSummaryHeading>{t('searchEngines.fixFields')}</ErrorSummaryHeading>
          <ErrorSummaryList>
            {errorLinks.map((l) => (
              <ErrorSummaryItem key={l.id}>
                <ErrorSummaryLink
                  href={`#${l.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(l.id)?.focus();
                  }}
                >
                  {l.text}
                </ErrorSummaryLink>
              </ErrorSummaryItem>
            ))}
          </ErrorSummaryList>
        </ErrorSummary>
      ) : null}

      <Field className="endpoint-name">
        <Label>{t('searchEngines.nameLabel')}</Label>
        <Input
          id="ep-name"
          value={name}
          aria-invalid={nameError ? true : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {nameError ? <ValidationMessage>{nameError}</ValidationMessage> : null}
      </Field>

      {isNew ? (
        <fieldset className="engine-fieldset">
          <legend className="ds-label">{t('searchEngines.engineLegend')}</legend>
          <div className="engine-choices">
            {engines.map((e) => (
              <label
                key={e.engine}
                className="engine-choice"
                data-checked={e.engine === engineId || undefined}
              >
                <input
                  className="ds-input"
                  type="radio"
                  name="ep-engine"
                  checked={e.engine === engineId}
                  onChange={() => pickEngine(e)}
                />
                <span className="engine-choice-body">
                  <span className="engine-choice-name">{e.title}</span>
                  {e.tech ? <span className="meta">{e.tech}</span> : null}
                  <span>
                    {t('searchEngines.capabilityCount', {
                      count: capabilityCount(e),
                      total: capabilityTotal,
                    })}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <p className="engine-line">
          {t.rich('searchEngines.engineLine', {
            engine: engine.title,
            strong: (c) => <strong>{c}</strong>,
          })}
          {engine.tech ? <span className="meta"> · {engine.tech}</span> : null}
        </p>
      )}

      <section aria-labelledby="ep-opt-h" className="card stack endpoint-options">
        <div className="stack-xs">
          <Heading level={2} data-size="xs" id="ep-opt-h">
            {t('searchEngines.settingsFor', { engine: engine.title })}
          </Heading>
          <span className="meta">{t('searchEngines.schemaGenerated')}</span>
        </div>
        {engine.builtin ? (
          <Alert data-color="info" data-size="sm">
            {t('searchEngines.builtinNote')}
          </Alert>
        ) : null}
        {fields.map((f) => (
          <FieldControl
            key={f.key}
            field={f}
            value={values[f.key]}
            error={errors[f.key]}
            secrets={secrets}
            onChange={(v) => setValue(f.key, v)}
          />
        ))}
        <Details>
          <DetailsSummary>{t('searchEngines.schemaFromApi')}</DetailsSummary>
          <DetailsContent>
            <pre tabIndex={0} aria-label={t('searchEngines.jsonSchema')} className="schema-json">
              <code>{JSON.stringify(schema, null, 2)}</code>
            </pre>
          </DetailsContent>
        </Details>
      </section>

      {engine.builtin ? null : (
        <div className="actions-row">
          <Button
            variant="secondary"
            aria-disabled={testing || undefined}
            onClick={() => {
              if (!testing) void runTest();
            }}
          >
            {t('searchEngines.testConnection')}
          </Button>
          <span role="status" className="test-status">
            {testing ? (
              <>
                <Spinner aria-hidden data-size="xs" />
                {t('searchEngines.connecting')}
              </>
            ) : null}
            {test ? (
              <>
                <Tag data-size="sm" data-color={test.ok ? 'success' : 'danger'}>
                  {testTag}
                </Tag>
                {testText}
              </>
            ) : null}
          </span>
        </div>
      )}

      <div className="stack-sm endpoint-save">
        <p className="endpoint-impact">
          {isNew
            ? t('searchEngines.impactNew')
            : t('searchEngines.impactExisting', { count: endpoint.datasetCount })}
        </p>
        <Field className="endpoint-reason">
          <Label>{t('common.reason')}</Label>
          <Textarea
            rows={2}
            value={reason}
            aria-invalid={reasonError ? true : undefined}
            onChange={(e) => {
              setReason(e.target.value);
              setReasonError('');
            }}
          />
          {reasonError ? <ValidationMessage>{reasonError}</ValidationMessage> : null}
        </Field>
        {problem ? (
          <Alert data-color="danger" data-size="sm">
            {problem}
          </Alert>
        ) : null}
        <div className="actions-row">
          <Button loading={busy} onClick={() => void save()}>
            {t('searchEngines.saveEndpoint')}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="tertiary"
            data-size="sm"
            onClick={() =>
              setCall({
                title: t('searchEngines.saveEndpoint'),
                method: 'PUT',
                path: `/operator/catalog/knowledge-endpoint/${encodeURIComponent(id)}`,
                body: spec,
              })
            }
          >
            <CodeIcon />
            {t('common.showApiCall')}
          </Button>
        </div>
      </div>
      {call ? <ApiCallPanel call={call} onClose={() => setCall(undefined)} /> : null}
    </div>
  );
};

export const CodeIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
  </svg>
);
