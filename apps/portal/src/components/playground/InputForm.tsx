import {
  Checkbox,
  Field,
  Fieldset,
  Label,
  Paragraph,
  Select,
  EXPERIMENTAL_Suggestion as Suggestion,
  Tag,
  Textarea,
  Textfield,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useId } from 'react';
import type { PlaygroundInputField as InputField } from '../../api/playground';
import { translator, useT, type T } from '../../i18n';
import './playground.css';

export type FormInput = Record<string, string | number | string[]>;

export type FormValues = Record<string, string | string[]>;

const nbT = translator('nb');

const required = (field: InputField, t: T) =>
  field.required ? (
    <Tag data-size="sm" data-color="warning" className="input-form-required">
      {t('playground.required')}
    </Tag>
  ) : null;

const filled = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value.length > 0 : !!value?.trim();

export const formErrors = (fields: InputField[], values: FormValues, t: T = nbT) =>
  Object.fromEntries(
    fields
      .filter((f) => f.required && !filled(values[f.id]))
      .map((f) => [f.id, t('playground.fillIn', { label: f.label })]),
  );

export const formInput = (fields: InputField[], values: FormValues): FormInput =>
  Object.fromEntries(
    fields.flatMap((f): [string, string | number | string[]][] => {
      const value = values[f.id];
      if (!filled(value)) return [];
      if (Array.isArray(value)) return [[f.id, value]];
      const text = (value ?? '').trim();
      return [[f.id, f.kind === 'number' || f.kind === 'year' ? Number(text) : text]];
    }),
  );

export const filledValues = (fields: InputField[], values: FormValues) =>
  fields.flatMap((f) => {
    const value = values[f.id];
    if (!filled(value)) return [];
    return [{ label: f.label, value: Array.isArray(value) ? value.join(', ') : (value ?? '') }];
  });

interface Props {
  fields: InputField[];
  values: FormValues;
  errors: Record<string, string>;
  onChange: (id: string, value: string | string[]) => void;
  intro: string;
}

export const manyOptions = 12;

const FormField = ({
  prefix,
  field,
  value,
  error,
  onChange,
}: {
  prefix: string;
  field: InputField;
  value: string | string[] | undefined;
  error: string | undefined;
  onChange: (value: string | string[]) => void;
}) => {
  const t = useT();
  const id = `${prefix}-${field.id}`;
  const text = typeof value === 'string' ? value : '';
  const label = (
    <>
      {field.label} {required(field, t)}
    </>
  );
  if (
    (field.options?.length ?? 0) > manyOptions &&
    (field.kind === 'multi-choice' || field.kind === 'choice' || field.kind === 'organisation')
  ) {
    const multiple = field.kind === 'multi-choice';
    const chosen = Array.isArray(value) ? value : [];
    const list = (
      <Suggestion.List>
        <Suggestion.Empty>{t('playground.noMatches')}</Suggestion.Empty>
        {(field.options ?? []).map((option) => (
          <Suggestion.Option key={option} value={option} label={option}>
            {option}
          </Suggestion.Option>
        ))}
      </Suggestion.List>
    );
    const input = (
      <>
        <Suggestion.Input id={id} aria-invalid={error ? true : undefined} />
        <Suggestion.Clear aria-label={t('playground.clearField', { label: field.label })} />
      </>
    );
    return (
      <Field data-size="sm">
        <Label htmlFor={id}>{label}</Label>
        <Field.Description>
          {[field.help, t(multiple ? 'playground.searchHintMany' : 'playground.searchHint')]
            .filter(Boolean)
            .join(' ')}
        </Field.Description>
        {multiple ? (
          <Suggestion
            multiple
            selected={chosen}
            onSelectedChange={(items) => onChange(items.map((item) => item.value))}
          >
            {input}
            {list}
          </Suggestion>
        ) : (
          <Suggestion
            selected={text || null}
            onSelectedChange={(item) => onChange(item?.value ?? '')}
          >
            {input}
            {list}
          </Suggestion>
        )}
        {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      </Field>
    );
  }
  if (field.kind === 'multi-choice') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <Fieldset data-size="sm">
        <Fieldset.Legend>{label}</Fieldset.Legend>
        {field.help ? <Fieldset.Description>{field.help}</Fieldset.Description> : null}
        {(field.options ?? []).map((option) => (
          <Checkbox
            key={option}
            label={option}
            value={option}
            checked={chosen.includes(option)}
            onChange={() =>
              onChange(
                chosen.includes(option) ? chosen.filter((c) => c !== option) : [...chosen, option],
              )
            }
          />
        ))}
        {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      </Fieldset>
    );
  }
  if ((field.kind === 'choice' || field.kind === 'organisation') && field.options?.length) {
    return (
      <Field data-size="sm">
        <Label htmlFor={id}>{label}</Label>
        {field.help ? <Field.Description>{field.help}</Field.Description> : null}
        <Select
          id={id}
          value={text}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        >
          <Select.Option value="">{t('playground.choose')}</Select.Option>
          {field.options.map((option) => (
            <Select.Option key={option} value={option}>
              {option}
            </Select.Option>
          ))}
        </Select>
        {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      </Field>
    );
  }
  if (field.kind === 'long-text') {
    return (
      <Field data-size="sm">
        <Label htmlFor={id}>{label}</Label>
        {field.help ? <Field.Description>{field.help}</Field.Description> : null}
        <Textarea
          id={id}
          rows={3}
          value={text}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        {error ? <ValidationMessage>{error}</ValidationMessage> : null}
      </Field>
    );
  }
  return (
    <Textfield
      data-size="sm"
      id={id}
      label={label}
      {...(field.help ? { description: field.help } : {})}
      {...(error ? { error } : {})}
      {...(field.kind === 'date' ? { type: 'date' } : {})}
      {...(field.kind === 'number' ? { type: 'number' } : {})}
      {...(field.kind === 'year' ? { inputMode: 'numeric' as const, maxLength: 4 } : {})}
      value={text}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};

export const InputForm = ({ fields, values, errors, onChange, intro }: Props) => {
  const prefix = useId();
  return (
    <div className="input-form">
      <Paragraph data-size="sm">{intro}</Paragraph>
      {fields.map((field) => (
        <FormField
          key={field.id}
          prefix={prefix}
          field={field}
          value={values[field.id]}
          error={errors[field.id]}
          onChange={(value) => onChange(field.id, value)}
        />
      ))}
    </div>
  );
};
