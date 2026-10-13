import { Alert, Button, Field, Label, Paragraph, Textarea } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { ApiError, type ApiClient, type DraftRunResult } from '../../api';
import type { PlaygroundInputField } from '../../api/playground';
import {
  formErrors,
  formInput,
  InputForm,
  type FormValues,
} from '../../components/playground/InputForm';
import {
  isModelFailure,
  ModelNoAnswer,
  RunFailure,
  type RunFailureInfo,
} from '../../components/RunFailure';
import { inputFieldsOf, withOptionsFrom } from '../../data/playground';
import { useT } from '../../i18n';
import { problemErrors } from './definition';
import './sections.css';

interface Props {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  draft?: Record<string, unknown> | string;
  files?: Record<string, string>;
}

export const TestRun = ({ api, tenant, serviceId, draft, files }: Props) => {
  const t = useT();
  const [query, setQuery] = useState('');
  const [queryErr, setQueryErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DraftRunResult>();
  const [failed, setFailed] = useState<{ path: string; message: string }[]>();
  const [failure, setFailure] = useState<RunFailureInfo>();
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [resolved, setResolved] = useState<PlaygroundInputField[]>();
  const fields =
    typeof draft === 'object' ? withOptionsFrom(inputFieldsOf(draft), resolved) : (resolved ?? []);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      void (async () => {
        const definition =
          draft ?? (await api.getDefinition(tenant, 'Service', serviceId)).latest.definition;
        const found = await api.draftInputFields(tenant, definition);
        if (current) setResolved(found);
      })().catch(() => undefined);
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, tenant, serviceId, draft]);

  const run = async () => {
    if (fields.length) {
      const missing = formErrors(fields, values);
      setErrors(missing);
      if (Object.keys(missing).length) return;
    } else if (!query.trim()) {
      setQueryErr(t('serviceTest.queryRequired'));
      return;
    }
    setBusy(true);
    setResult(undefined);
    setFailed(undefined);
    setFailure(undefined);
    try {
      let definition = draft;
      let prompts = files ?? {};
      if (definition === undefined) {
        const latest = await api.getDefinition(tenant, 'Service', serviceId);
        definition = latest.latest.definition;
        prompts = latest.latest.files ?? {};
      }
      setResult(
        await api.testRunDraft(
          tenant,
          definition,
          query.trim(),
          prompts,
          fields.length ? formInput(fields, values) : undefined,
        ),
      );
    } catch (error) {
      const problem =
        error instanceof ApiError && error.status === 502
          ? (error.problem as Partial<RunFailureInfo> & { errors?: { message: string }[] })
          : undefined;
      if (problem?.code)
        setFailure({
          code: problem.code,
          ...(problem.title ? { title: problem.title } : {}),
          ...(problem.step ? { step: problem.step } : {}),
          ...(problem.runId ? { runId: problem.runId } : {}),
          ...(problem.errors?.[0]?.message ? { detail: problem.errors[0].message } : {}),
        });
      else setFailed(problemErrors(error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm">
      <Paragraph data-size="sm">
        {draft === undefined ? t('serviceTest.runsLive') : t('serviceTest.runsDraft')}{' '}
        {t('serviceTest.costNote')}
      </Paragraph>
      {fields.length ? (
        <InputForm
          fields={fields}
          values={values}
          errors={errors}
          intro={t('serviceTest.formIntro')}
          onChange={(id, value) => {
            setValues((v) => ({ ...v, [id]: value }));
            setErrors(({ [id]: _cleared, ...rest }) => rest);
          }}
        />
      ) : null}
      <Field>
        <Label htmlFor="prove-sporsmal">
          {fields.length ? t('serviceTest.noteOptional') : t('serviceTest.question')}
        </Label>
        <Textarea
          id="prove-sporsmal"
          rows={3}
          value={query}
          aria-invalid={queryErr ? true : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setQueryErr('');
          }}
        />
        {queryErr ? <Field.Description role="alert">{queryErr}</Field.Description> : null}
      </Field>
      <Button
        variant="primary"
        data-size="sm"
        className="align-start"
        loading={busy}
        onClick={() => !busy && void run()}
      >
        {t('serviceTest.run')}
      </Button>
      <div aria-live="polite" className="stack-sm">
        {result ? (
          <div className="test-run-result stack-xs">
            {result.noAnswer || !result.answer.trim() ? (
              <span className="strong">{t('serviceTest.noAnswer')}</span>
            ) : (
              <>
                <span className="strong">{t('serviceTest.answer')}</span>
                <p className="pre-wrap">{result.answer}</p>
              </>
            )}
            <a href={`#/log/${encodeURIComponent(result.task)}`} className="meta">
              {t('serviceTest.seeRun')}
            </a>
          </div>
        ) : null}
        {failure && isModelFailure(failure) ? (
          <ModelNoAnswer
            text={t('serviceTest.modelNoAnswer')}
            busy={busy}
            onRetry={() => void run()}
          />
        ) : failure ? (
          <RunFailure failure={failure} busy={busy} onRetry={() => void run()} />
        ) : null}
        {failed ? (
          <Alert data-color="danger" data-size="sm">
            <Paragraph data-size="sm">{t('serviceTest.failed')}</Paragraph>
            <ul className="bullets">
              {failed.map((e) => (
                <li key={`${e.path}${e.message}`}>
                  {e.path ? <code>{e.path}</code> : null}
                  {e.path ? ': ' : ''}
                  {e.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
      </div>
    </div>
  );
};
