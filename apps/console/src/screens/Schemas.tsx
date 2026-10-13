import {
  Alert,
  Button,
  Field,
  Heading,
  Label,
  Paragraph,
  Select,
} from '@digdir/designsystemet-react';
import {
  SchemaForm,
  resolveText,
  undescribedPaths,
  useSchema,
  useSchemaList,
  validate,
  type SchemaRef,
  type Value,
} from '@genai/schema-forms';
import { useLocale } from '@genai/i18n/react';
import { useState } from 'react';
import type { ApiClient } from '../api';
import { useT } from '../i18n';
import { EmptyState, ErrorState, Loading } from '../states';
import { PageHeader } from '../ui';

const keyOf = (ref: SchemaRef) => `${ref.kind}@${ref.version}`;

const Generated = ({ api, chosen }: { api: ApiClient; chosen: SchemaRef }) => {
  const t = useT();
  const loaded = useSchema(api.getJson, chosen.href ?? chosen.kind, chosen.version);
  const [value, setValue] = useState<Value>({});
  const [attempt, setAttempt] = useState(0);
  if (loaded.status === 'loading') return <Loading label={t('schemas.loading')} />;
  if (loaded.status === 'failed') return <ErrorState error={loaded.error} />;
  const schema = loaded.data;
  const fine =
    attempt > 0 &&
    Object.keys(validate(schema, value)).length === 0 &&
    undescribedPaths(schema, value).length === 0;
  return (
    <section className="stack" aria-labelledby="schema-form-title">
      <Heading level={2} data-size="xs" id="schema-form-title">
        {t('schemas.formTitle')}
      </Heading>
      <SchemaForm
        key={keyOf(chosen)}
        schema={schema}
        value={value}
        onChange={setValue}
        fetchJson={api.getJson}
        uses={chosen.uses ?? []}
        operator
        showErrors={attempt > 0}
        attempt={attempt}
      />
      {fine ? (
        <Alert data-color="success" data-size="sm">
          {t('schemas.valid')}
        </Alert>
      ) : null}
      <div className="actions-row">
        <Button variant="primary" data-size="sm" onClick={() => setAttempt((n) => n + 1)}>
          {t('schemas.check')}
        </Button>
        <Button
          variant="secondary"
          data-size="sm"
          onClick={() => {
            setValue({});
            setAttempt(0);
          }}
        >
          {t('schemas.reset')}
        </Button>
      </div>
      <Heading level={3} data-size="2xs">
        {t('schemas.preview')}
      </Heading>
      <pre className="code" aria-label={t('schemas.preview')}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
};

export const Schemas = ({ api, initial }: { api: ApiClient; initial?: string | undefined }) => {
  const t = useT();
  const { locale } = useLocale();
  const list = useSchemaList(api.getJson);
  const [picked, setPicked] = useState<string | undefined>(initial);
  const header = (
    <PageHeader
      title={t('schemas.page')}
      eyebrow={t('schemas.eyebrow')}
      intro={t('schemas.intro')}
    />
  );
  if (list.status === 'loading')
    return (
      <>
        {header}
        <Loading label={t('schemas.loading')} />
      </>
    );
  if (list.status === 'failed')
    return (
      <>
        {header}
        <ErrorState error={list.error} />
      </>
    );
  const refs = list.data;
  if (refs.length === 0)
    return (
      <>
        {header}
        <EmptyState title={t('schemas.empty')} />
      </>
    );
  const chosen = refs.find((r) => keyOf(r) === picked || r.kind === picked) ?? refs[0];
  const name = (r: SchemaRef) => resolveText(r.label, locale) ?? r.kind;
  return (
    <>
      {header}
      <Field data-size="sm" className="schema-picker">
        <Label htmlFor="schema-kind">{t('schemas.choose')}</Label>
        <Select
          id="schema-kind"
          value={chosen ? keyOf(chosen) : ''}
          onChange={(e) => {
            setPicked(e.target.value);
            window.history.replaceState(
              null,
              '',
              `#/schemas?kind=${encodeURIComponent(e.target.value)}`,
            );
          }}
        >
          {refs.map((r) => (
            <Select.Option key={keyOf(r)} value={keyOf(r)}>
              {`${name(r)} (${r.kind}, ${t('schemas.version', { version: r.version })})`}
            </Select.Option>
          ))}
        </Select>
      </Field>
      {chosen?.help ? (
        <Paragraph data-size="sm">{resolveText(chosen.help, locale)}</Paragraph>
      ) : null}
      {chosen ? <Generated key={keyOf(chosen)} api={api} chosen={chosen} /> : null}
    </>
  );
};
