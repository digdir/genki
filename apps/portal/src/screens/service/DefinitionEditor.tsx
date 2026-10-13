import {
  Alert,
  Button,
  Field,
  Label,
  Paragraph,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { ApiCallLink } from '../../components/ApiCall';
import { CopyButton } from '../../components/CopyButton';
import { useAsync } from '../../hooks';
import { useT } from '../../i18n';
import { ErrorState, Loading } from '../../states';
import type { PublishedDefinition } from '../../types';
import { definitionYaml, problemErrors } from './definition';
import './sections.css';
import { reasonProblem } from '../../components/ReasonField';

type Check =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'valid' }
  | { kind: 'invalid'; errors: { path: string; message: string }[] };

interface Props {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  onPublished?: (published: PublishedDefinition) => void;
}

const Errors = ({ errors }: { errors: { path: string; message: string }[] }) => {
  const t = useT();
  return (
    <Alert data-color="danger" data-size="sm">
      <Paragraph data-size="sm">{t('serviceEditor.invalid')}</Paragraph>
      <ul className="bullets">
        {errors.map((e) => (
          <li key={`${e.path}${e.message}`}>
            {e.path ? <code>{e.path}</code> : null}
            {e.path ? ': ' : ''}
            {e.message}
          </li>
        ))}
      </ul>
    </Alert>
  );
};

const Editor = ({
  api,
  latest,
  onPublished,
}: {
  api: ApiClient;
  latest: PublishedDefinition;
  onPublished: (published: PublishedDefinition) => void;
}) => {
  const t = useT();
  const original = definitionYaml(latest.definition);
  const [text, setText] = useState(original);
  const [reason, setReason] = useState('');
  const [reasonErr, setReasonErr] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  const files = latest.files ?? {};
  const clean = text === original;

  const validate = async () => {
    setCheck({ kind: 'busy' });
    try {
      const result = await api.validate(text, files);
      setCheck(result.valid ? { kind: 'valid' } : { kind: 'invalid', errors: result.errors });
    } catch (error) {
      setCheck({ kind: 'invalid', errors: problemErrors(error, t) });
    }
  };

  const publish = async () => {
    if (clean) return;
    const reasonError = reasonProblem(reason);
    if (reasonError) {
      setReasonErr(reasonError);
      return;
    }
    setCheck({ kind: 'busy' });
    try {
      const result = await api.validate(text, files);
      if (!result.valid) {
        setCheck({ kind: 'invalid', errors: result.errors });
        return;
      }
      const published = await api.publishDefinition(text, files, reason.trim());
      onPublished(published);
    } catch (error) {
      setCheck({ kind: 'invalid', errors: problemErrors(error, t) });
    }
  };

  const busy = check.kind === 'busy';
  return (
    <div className="stack-sm">
      <Field>
        <Label htmlFor="definisjon-yaml">{t('serviceEditor.label')}</Label>
        <Field.Description>
          {t('serviceEditor.description', { version: latest.version })}
        </Field.Description>
        <Textarea
          id="definisjon-yaml"
          className="service-yaml-editor"
          rows={28}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCheck({ kind: 'idle' });
          }}
        />
      </Field>
      <Textfield
        label={t('serviceEditor.reason')}
        description={t('serviceEditor.reasonDescription')}
        value={reason}
        error={reasonErr || undefined}
        onChange={(e) => {
          setReason(e.target.value);
          setReasonErr('');
        }}
      />
      <div className="row-wrap">
        <Button
          variant="primary"
          data-size="sm"
          aria-disabled={clean || busy || undefined}
          onClick={() => !busy && void publish()}
        >
          {t('serviceEditor.publish')}
        </Button>
        <Button
          variant="secondary"
          data-size="sm"
          aria-disabled={busy || undefined}
          onClick={() => !busy && void validate()}
        >
          {t('serviceEditor.check')}
        </Button>
        <Button
          variant="tertiary"
          data-size="sm"
          aria-disabled={clean || undefined}
          onClick={() => {
            setText(original);
            setCheck({ kind: 'idle' });
          }}
        >
          {t('serviceEditor.discard')}
        </Button>
        <CopyButton text={text} />
        <ApiCallLink
          call={{
            action: t('serviceEditor.apiAction'),
            method: 'POST',
            path: '/definitions',
            body: { definition: '<YAML>', files: {} },
            right: 'Administrere tjenester',
          }}
        />
      </div>
      <div aria-live="polite">
        {check.kind === 'valid' ? (
          <Alert data-color="success" data-size="sm">
            {t('serviceEditor.valid')}
          </Alert>
        ) : null}
        {check.kind === 'invalid' ? <Errors errors={check.errors} /> : null}
      </div>
    </div>
  );
};

export const DefinitionEditor = ({ api, tenant, serviceId, onPublished }: Props) => {
  const t = useT();
  const [round, setRound] = useState(0);
  const [published, setPublished] = useState<number>();
  const [state, retry] = useAsync(
    (signal) => api.getDefinition(tenant, 'Service', serviceId, signal),
    [api, tenant, serviceId, round],
  );
  if (state.status === 'loading') return <Loading label={t('serviceEditor.loading')} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  return (
    <div className="stack-sm">
      <div aria-live="polite">
        {published ? (
          <Alert data-color="success" data-size="sm">
            {t('serviceEditor.published', { version: published })}
          </Alert>
        ) : null}
      </div>
      <Editor
        key={state.data.latest.version}
        api={api}
        latest={state.data.latest}
        onPublished={(result) => {
          setPublished(result.version);
          onPublished?.(result);
          setRound((r) => r + 1);
        }}
      />
    </div>
  );
};
