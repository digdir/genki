import {
  Field,
  Label,
  Select,
  EXPERIMENTAL_Suggestion as Suggestion,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { useT } from '../../i18n';

export interface Option {
  value: string;
  label: string;
}

export const SelectField = ({
  id,
  label,
  value,
  options,
  onChange,
  error,
  description,
  placeholder,
  size,
}: {
  id: string;
  label: ReactNode;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  error?: string;
  description?: string;
  placeholder?: string;
  size?: 'sm';
}) => (
  <Field {...(size ? { 'data-size': size } : {})}>
    <Label htmlFor={id}>{label}</Label>
    {description ? <Field.Description>{description}</Field.Description> : null}
    <Select
      id={id}
      value={value}
      aria-invalid={error ? true : undefined}
      onChange={(e) => onChange(e.target.value)}
    >
      {placeholder !== undefined ? <Select.Option value="">{placeholder}</Select.Option> : null}
      {options.map((o) => (
        <Select.Option key={o.value} value={o.value}>
          {o.label}
        </Select.Option>
      ))}
    </Select>
    {error ? <ValidationMessage>{error}</ValidationMessage> : null}
  </Field>
);

export const SearchField = ({
  id,
  label,
  clearLabel,
  value,
  options,
  onChange,
  error,
  description,
}: {
  id: string;
  label: ReactNode;
  clearLabel: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  error?: string;
  description?: string;
}) => {
  const t = useT();
  const chosen = options.find((o) => o.value === value);
  return (
    <Field>
      <Label htmlFor={id}>{label}</Label>
      {description ? <Field.Description>{description}</Field.Description> : null}
      <Suggestion
        selected={chosen ?? null}
        onSelectedChange={(item) => {
          if ((item?.value ?? '') !== value) onChange(item?.value ?? '');
        }}
      >
        <Suggestion.Input id={id} aria-invalid={error ? true : undefined} />
        <Suggestion.Clear aria-label={clearLabel} />
        <Suggestion.List>
          <Suggestion.Empty>{t('playground.noMatches')}</Suggestion.Empty>
          {options.map((o) => (
            <Suggestion.Option key={o.value} value={o.value} label={o.label}>
              {o.label}
            </Suggestion.Option>
          ))}
        </Suggestion.List>
      </Suggestion>
      {error ? <ValidationMessage>{error}</ValidationMessage> : null}
    </Field>
  );
};
