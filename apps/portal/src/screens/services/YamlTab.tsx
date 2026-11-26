import {
  Alert,
  Button,
  Field,
  Label,
  Paragraph,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useRef, useState } from 'react';
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
  /** The draft's prompt files, which the platform checks the definition's references against. */
  files: Record<string, string>;
  onApply: (definition: Record<string, unknown>) => void;
}

export const YamlTab = ({ api, generated, files, onApply }: Props) => {
  const t = useT();
  const [edit, setEdit] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [parseError, setParseError] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  const text = edit ?? generated;
  const clean = edit === null || edit === generated;
  const shown = useRef(text);
  shown.current = text;

  // The draft gets only text the platform's schema takes; what it refuses stays in the field.
  const apply = async () => {
    if (clean || check.kind === 'busy') return;
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new YamlError(1, t('yamlTab.mustBeObject'));
    } catch (error) {
      setParseError(error instanceof YamlError ? error.message : t('yamlTab.unreadable'));
      return;
    }
    setCheck({ kind: 'busy' });
    try {
      const result = await api.validate(text, files);
      // Text typed while the check ran is not what was checked; it waits for the next «Bruk».
      if (shown.current !== text) return;
      if (!result.valid) {
        setCheck({ kind: 'invalid', errors: result.errors });
        return;
      }
    } catch {
      setCheck({ kind: 'failed' });
      return;
    }
    setCheck({ kind: 'idle' });
    onApply(parsed as Record<string, unknown>);
    setEdit(null);
    setNote(t('yamlTab.applied'));
  };

  const validate = async () => {
    setCheck({ kind: 'busy' });
    try {
      const result = await api.validate(text, files);
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
        <Button
          variant="primary"
          data-size="sm"
          aria-disabled={clean || check.kind === 'busy' || undefined}
          onClick={() => void apply()}
        >
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
