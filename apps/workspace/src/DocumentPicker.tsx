import {
  Button,
  Field,
  Input,
  Label,
  Paragraph,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState, type ChangeEvent } from 'react';
import { useT } from './i18n';
import type { AttachedDocument, DocumentRules } from './types';

const byExtension: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};

const extensionsOf = (type: string) =>
  Object.entries(byExtension).flatMap(([ext, t]) => (t === type ? [`.${ext}`] : []));

export const documentType = (file: { name: string; type: string }, accepts: string[]) => {
  const declared = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (accepts.includes(declared)) return declared;
  const guessed = byExtension[file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()];
  return guessed && accepts.includes(guessed) ? guessed : undefined;
};

const base64Of = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

interface Props {
  id: string;
  rules: DocumentRules;
  documents: AttachedDocument[];
  onChange: (documents: AttachedDocument[]) => void;
}

export const DocumentPicker = ({ id, rules, documents, onChange }: Props) => {
  const t = useT();
  const f = useFormat();
  const [error, setError] = useState('');
  const size = f.bytes(rules.maxBytes);

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    setError('');
    if (documents.length + files.length > rules.maxCount) {
      setError(t('chat.documentTooMany', { count: rules.maxCount }));
      return;
    }
    const added: AttachedDocument[] = [];
    for (const file of files) {
      const mediaType = documentType(file, rules.accepts);
      if (!mediaType) {
        setError(t('chat.documentWrongType', { name: file.name }));
        return;
      }
      if (file.size > rules.maxBytes) {
        setError(t('chat.documentTooLarge', { name: file.name, size }));
        return;
      }
      try {
        added.push({ name: file.name, mediaType, data: await base64Of(file) });
      } catch {
        setError(t('chat.documentUnreadable', { name: file.name }));
        return;
      }
    }
    onChange([...documents, ...added]);
  };

  return (
    <Field data-size="sm">
      <Label htmlFor={id}>
        {t('chat.attach')} <span className="subtle-label">{t('chat.optional')}</span>
      </Label>
      <Paragraph id={`${id}-help`} data-size="sm" className="subtle-sm">
        {t('chat.attachHelp', {
          types: f.list(rules.accepts.flatMap(extensionsOf)),
          size,
          count: rules.maxCount,
        })}
      </Paragraph>
      <Input
        id={id}
        type="file"
        multiple={rules.maxCount > 1}
        accept={[...rules.accepts, ...rules.accepts.flatMap(extensionsOf)].join(',')}
        aria-describedby={[`${id}-help`, error ? `${id}-error` : ''].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        onChange={(e) => void pick(e)}
      />
      {error ? <ValidationMessage id={`${id}-error`}>{error}</ValidationMessage> : null}
      {documents.length ? (
        <ul className="plain-list" aria-label={t('chat.attached')}>
          {documents.map((d, i) => (
            <li key={`${d.name}-${i}`}>
              {d.name}{' '}
              <Button
                variant="tertiary"
                data-size="sm"
                onClick={() => onChange(documents.filter((_, n) => n !== i))}
              >
                {t('chat.removeDocument', { name: d.name })}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Field>
  );
};
