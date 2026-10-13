import { Field, Label, Select, ValidationMessage } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';

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
