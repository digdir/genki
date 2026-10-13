import {
  Alert,
  Button,
  Field,
  Label,
  Paragraph,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import type { ApiClient } from '../../api';
import { ApiCallLink } from '../../components/ApiCall';
import { CopyButton } from '../../components/CopyButton';
import { useT } from '../../i18n';
import { parseYaml, YamlError } from '../../yaml';

type Check =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'valid' }
  | { kind: 'invalid'; errors: { path: string; message: string }[] }
  | { kind: 'failed' };

interface Props {
  api: ApiClient;
  generated: string;
  onApply: (definition: Record<string, unknown>) => void;
}

export const YamlTab = ({ api, generated, onApply }: Props) => {
  const t = useT();
  const [edit, setEdit] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [parseError, setParseError] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  const text = edit ?? generated;
  const clean = edit === null || edit === generated;

  const apply = () => {
    if (clean) return;
    try {
      const parsed = parseYaml(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new YamlError(1, t('yamlTab.mustBeObject'));
      onApply(parsed as Record<string, unknown>);
      setEdit(null);
      setNote(t('yamlTab.applied'));
    } catch (error) {
      setParseError(error instanceof YamlError ? error.message : t('yamlTab.unreadable'));
    }
  };

  const validate = async () => {
    setCheck({ kind: 'busy' });
    try {
      const result = await api.validate(text);
      setCheck(result.valid ? { kind: 'valid' } : { kind: 'invalid', errors: result.errors });
    } catch {
      setCheck({ kind: 'failed' });
    }
  };

  return (
    <div className="stack-sm">
      <Field>
        <Label htmlFor="felt-yaml">{t('yamlTab.label')}</Label>
        <Field.Description>{t('yamlTab.description')}</Field.Description>
        <Textarea
          id="felt-yaml"
          className="yaml-editor"
          rows={30}
          spellCheck={false}
          value={text}
          aria-invalid={parseError ? true : undefined}
          onChange={(e) => {
            setEdit(e.target.value);
            setNote('');
            setParseError('');
            setCheck({ kind: 'idle' });
          }}
        />
        {parseError ? <ValidationMessage>{parseError}</ValidationMessage> : null}
      </Field>
      <div className="row-wrap">
        <Button variant="primary" data-size="sm" aria-disabled={clean || undefined} onClick={apply}>
          {t('yamlTab.apply')}
        </Button>
        <Button
          variant="secondary"
          data-size="sm"
          aria-disabled={clean || undefined}
          onClick={() => {
            if (clean) return;
            setEdit(null);
            setParseError('');
            setNote(t('yamlTab.discarded'));
          }}
        >
          {t('yamlTab.discard')}
        </Button>
        <Button
          variant="tertiary"
          data-size="sm"
          aria-disabled={check.kind === 'busy' || undefined}
          onClick={() => check.kind !== 'busy' && void validate()}
        >
          {t('yamlTab.validate')}
        </Button>
        <CopyButton text={text} />
        <ApiCallLink
          call={{
            action: t('yamlTab.apiAction'),
            method: 'POST',
            path: '/definitions/validate',
            body: { definition: '<YAML>', files: {} },
            right: t('yamlTab.apiRight'),
            needsReason: false,
          }}
        />
        <span aria-live="polite" className="meta">
          {note}
        </span>
      </div>
      <div aria-live="polite">
        {check.kind === 'valid' ? (
          <Alert data-color="success" data-size="sm">
            {t('yamlTab.valid')}
          </Alert>
        ) : null}
        {check.kind === 'invalid' ? (
          <Alert data-color="danger" data-size="sm">
            <Paragraph data-size="sm">{t('yamlTab.invalid')}</Paragraph>
            <ul className="bullets">
              {check.errors.map((e) => (
                <li key={`${e.path}${e.message}`}>
                  <code>{e.path}</code>: {e.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {check.kind === 'failed' ? (
          <Alert data-color="warning" data-size="sm">
            {t('yamlTab.failed')}
          </Alert>
        ) : null}
      </div>
    </div>
  );
};
