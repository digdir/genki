import {
  Button,
  Checkbox,
  Field,
  Fieldset,
  Input,
  Label,
  Select,
  Spinner,
  Switch,
  Textarea,
  ValidationMessage,
} from '@digdir/designsystemet-react';
import { useRef, useState, type ReactNode } from 'react';
import { useOptions } from './context.js';
import { useT } from './i18n.js';
import { isRecord, nonNull, typeOf, type UiSchema, type Widget } from './schema.js';

export interface WidgetProps {
  id: string;
  path: string;
  label: string;
  help: string | undefined;
  schema: UiSchema;
  widget: Widget;
  value: unknown;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  note: string | undefined;
  error: string | undefined;
  onChange: (value: unknown) => void;
  renderItem?: (
    schema: UiSchema,
    path: string,
    value: unknown,
    onChange: (v: unknown) => void,
  ) => ReactNode;
}

export type WidgetRenderer = (props: WidgetProps) => ReactNode;

const describedBy = (p: WidgetProps) =>
  [p.help || p.note ? `${p.id}-help` : '', p.error ? `${p.id}-error` : '']
    .filter(Boolean)
    .join(' ') || undefined;

const Shell = ({ p, children }: { p: WidgetProps; children: ReactNode }) => {
  const t = useT();
  return (
    <Field data-size="sm" className="sf-field">
      <Label htmlFor={p.id}>
        {p.label}
        {p.required ? null : <span className="sf-optional"> ({t('schemaForm.optional')})</span>}
      </Label>
      {p.help || p.note ? (
        <Field.Description id={`${p.id}-help`}>
          {[p.help, p.note].filter(Boolean).join(' ')}
        </Field.Description>
      ) : null}
      {children}
      {p.error ? <ValidationMessage id={`${p.id}-error`}>{p.error}</ValidationMessage> : null}
    </Field>
  );
};

const inputProps = (p: WidgetProps) => ({
  id: p.id,
  name: p.path,
  disabled: p.disabled,
  readOnly: p.readOnly,
  'aria-invalid': p.error ? true : undefined,
  'aria-describedby': describedBy(p),
  'aria-required': p.required || undefined,
});

const text = (v: unknown) =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);

const TextWidget = (p: WidgetProps) => (
  <Shell p={p}>
    <Input
      {...inputProps(p)}
      value={text(p.value)}
      onChange={(e) => p.onChange(e.target.value || undefined)}
    />
  </Shell>
);

const TextareaWidget = (p: WidgetProps) => (
  <Shell p={p}>
    <Textarea
      {...inputProps(p)}
      rows={p.widget === 'prompt' ? 10 : 4}
      className={p.widget === 'prompt' ? 'sf-prompt' : undefined}
      value={text(p.value)}
      onChange={(e) => p.onChange(e.target.value || undefined)}
    />
  </Shell>
);

const parseNumber = (raw: string) => {
  const cleaned = raw.trim().replace(/\s/g, '').replace(',', '.');
  if (cleaned === '') return undefined;
  const n = Number(cleaned);
  return Number.isNaN(n) ? raw : n;
};

const useSynced = (value: unknown, show: (v: unknown) => string) => {
  const emitted = useRef<unknown>(value);
  const [raw, setRaw] = useState(() => show(value));
  if (value !== emitted.current) {
    emitted.current = value;
    const next = show(value);
    if (next !== raw) setRaw(next);
  }
  return [raw, setRaw, emitted] as const;
};

const showNumber = (v: unknown) => (typeof v === 'number' ? String(v).replace('.', ',') : text(v));

const NumberWidget = (p: WidgetProps) => {
  const [raw, setRaw, emitted] = useSynced(p.value, showNumber);
  return (
    <Shell p={p}>
      <Input
        {...inputProps(p)}
        inputMode="decimal"
        className="sf-number"
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          const next = parseNumber(e.target.value);
          emitted.current = next;
          p.onChange(next);
        }}
      />
    </Shell>
  );
};

const ToggleWidget = (p: WidgetProps) => (
  <div className="sf-field">
    <Switch
      data-size="sm"
      id={p.id}
      name={p.path}
      label={p.label}
      {...(p.help || p.note ? { description: [p.help, p.note].filter(Boolean).join(' ') } : {})}
      checked={p.value === true}
      disabled={p.disabled || p.readOnly}
      onChange={(e) => p.onChange(e.target.checked)}
    />
    {p.error ? <ValidationMessage id={`${p.id}-error`}>{p.error}</ValidationMessage> : null}
  </div>
);

const SelectWidget = (p: WidgetProps) => {
  const t = useT();
  const state = useOptions(p.schema);
  if (state.status === 'none') return <TextWidget {...p} />;
  const options = state.status === 'ready' ? state.options : [];
  const current = text(p.value);
  const known = options.some((o) => o.value === current);
  return (
    <Shell
      p={{
        ...p,
        note:
          [p.note, state.status === 'failed' ? t('schemaForm.optionsFailed') : '']
            .filter(Boolean)
            .join(' ') || undefined,
      }}
    >
      {state.status === 'loading' ? (
        <Spinner aria-label={t('schemaForm.optionsLoading')} data-size="sm" />
      ) : null}
      <Select
        {...inputProps(p)}
        disabled={p.disabled || p.readOnly || state.status === 'loading'}
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          const type = typeOf(p.schema);
          p.onChange(
            v === '' ? undefined : type === 'integer' || type === 'number' ? Number(v) : v,
          );
        }}
      >
        <Select.Option value="">
          {p.required && p.schema.default === undefined
            ? t('schemaForm.choose')
            : t('schemaForm.useDefault')}
        </Select.Option>
        {current && !known ? <Select.Option value={current}>{current}</Select.Option> : null}
        {options.map((o) => (
          <Select.Option key={o.value} value={o.value}>
            {o.label}
          </Select.Option>
        ))}
      </Select>
    </Shell>
  );
};

const MultiselectWidget = (p: WidgetProps) => {
  const t = useT();
  const state = useOptions(p.schema);
  const chosen = Array.isArray(p.value) ? p.value.map(String) : [];
  if (state.status === 'none') return <ListWidget {...p} />;
  const options = state.status === 'ready' ? state.options : [];
  return (
    <Fieldset data-size="sm" className="sf-field" aria-describedby={describedBy(p)}>
      <Fieldset.Legend>{p.label}</Fieldset.Legend>
      {p.help || p.note || state.status === 'failed' ? (
        <Fieldset.Description id={`${p.id}-help`}>
          {[p.help, p.note, state.status === 'failed' ? t('schemaForm.optionsFailed') : '']
            .filter(Boolean)
            .join(' ')}
        </Fieldset.Description>
      ) : null}
      {state.status === 'loading' ? (
        <Spinner aria-label={t('schemaForm.optionsLoading')} data-size="sm" />
      ) : null}
      {options.map((o, i) => (
        <Checkbox
          key={o.value}
          id={i === 0 ? p.id : `${p.id}-${i}`}
          label={o.label}
          value={o.value}
          checked={chosen.includes(o.value)}
          disabled={p.disabled || p.readOnly}
          aria-invalid={p.error ? true : undefined}
          onChange={(e) => {
            const next = e.target.checked
              ? [...chosen, o.value]
              : chosen.filter((v) => v !== o.value);
            p.onChange(next.length ? next : undefined);
          }}
        />
      ))}
      {p.error ? <ValidationMessage id={`${p.id}-error`}>{p.error}</ValidationMessage> : null}
    </Fieldset>
  );
};

const SecretWidget = (p: WidgetProps) => {
  const t = useT();
  const stored = p.value !== undefined && p.value !== null && p.value !== '';
  const [typed, setTyped] = useState('');
  return (
    <Shell
      p={{
        ...p,
        note: [
          p.note,
          stored && !typed ? t('schemaForm.sensitiveSet') : t('schemaForm.sensitiveEmpty'),
        ]
          .filter(Boolean)
          .join(' '),
      }}
    >
      <Input
        {...inputProps(p)}
        type="password"
        autoComplete="new-password"
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          p.onChange(e.target.value === '' ? undefined : e.target.value);
        }}
      />
    </Shell>
  );
};

const CronWidget = (p: WidgetProps) => {
  const t = useT();
  return (
    <Shell p={{ ...p, help: [p.help, t('schemaForm.cronHelp')].filter(Boolean).join(' ') }}>
      <Input
        {...inputProps(p)}
        className="sf-mono"
        spellCheck={false}
        value={text(p.value)}
        onChange={(e) => p.onChange(e.target.value || undefined)}
      />
    </Shell>
  );
};

const showJson = (v: unknown) =>
  v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2);

const CodeWidget = (p: WidgetProps) => {
  const t = useT();
  const stringy = typeOf(p.schema) === 'string';
  const [raw, setRaw, emitted] = useSynced(p.value, stringy ? text : showJson);
  return (
    <Shell
      p={{
        ...p,
        help: stringy ? p.help : [p.help, t('schemaForm.codeHelp')].filter(Boolean).join(' '),
      }}
    >
      <Textarea
        {...inputProps(p)}
        rows={6}
        className="sf-mono"
        spellCheck={false}
        value={raw}
        onChange={(e) => {
          const next = e.target.value;
          setRaw(next);
          let parsed: unknown = next === '' ? undefined : next;
          if (!stringy && next.trim() !== '')
            try {
              parsed = JSON.parse(next) as unknown;
            } catch {
              parsed = next;
            }
          emitted.current = parsed;
          p.onChange(parsed);
        }}
      />
    </Shell>
  );
};

const ListWidget = (p: WidgetProps) => {
  const t = useT();
  const items = Array.isArray(p.value) ? p.value : [];
  const itemSchema = p.schema.items ? nonNull(p.schema.items) : { type: 'string' };
  const objects = typeOf(itemSchema) === 'object' && !!itemSchema.properties;
  const locked = p.disabled || p.readOnly;
  const set = (next: unknown[]) => p.onChange(next.length ? next : undefined);
  return (
    <Fieldset data-size="sm" className="sf-field sf-list" aria-describedby={describedBy(p)}>
      <Fieldset.Legend>{p.label}</Fieldset.Legend>
      {p.help || p.note ? (
        <Fieldset.Description id={`${p.id}-help`}>
          {[p.help, p.note].filter(Boolean).join(' ')}
        </Fieldset.Description>
      ) : null}
      <ol className="sf-items">
        {items.map((item, i) => {
          const name = t('schemaForm.item', { label: p.label, n: i + 1 });
          const update = (v: unknown) => set(items.map((x, j) => (j === i ? v : x)));
          return (
            <li key={i} className="sf-item">
              {objects && p.renderItem ? (
                <Fieldset data-size="sm">
                  <Fieldset.Legend>{name}</Fieldset.Legend>
                  {p.renderItem(itemSchema, `${p.path}.${i}`, item, update)}
                </Fieldset>
              ) : (
                <Field data-size="sm">
                  <Label htmlFor={`${p.id}-${i}`}>{name}</Label>
                  <Input
                    id={`${p.id}-${i}`}
                    disabled={p.disabled}
                    readOnly={p.readOnly}
                    value={typeof item === 'number' ? String(item) : text(item)}
                    onChange={(e) => {
                      const type = typeOf(itemSchema);
                      update(
                        type === 'integer' || type === 'number'
                          ? parseNumber(e.target.value)
                          : e.target.value,
                      );
                    }}
                  />
                </Field>
              )}
              {locked ? null : (
                <Button
                  variant="tertiary"
                  data-size="sm"
                  data-color="danger"
                  onClick={() => set(items.filter((_, j) => j !== i))}
                >
                  {t('schemaForm.remove', { label: name })}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      {locked ? null : (
        <div>
          <Button
            variant="secondary"
            data-size="sm"
            id={items.length === 0 ? p.id : undefined}
            onClick={() => set([...items, objects ? {} : ''])}
          >
            {t('schemaForm.add')}
          </Button>
        </div>
      )}
      {p.error ? <ValidationMessage id={`${p.id}-error`}>{p.error}</ValidationMessage> : null}
    </Fieldset>
  );
};

const MapWidget = (p: WidgetProps) => {
  const t = useT();
  const entries = isRecord(p.value) ? Object.entries(p.value) : [];
  const [rows, setRows] = useState<[string, string][]>(() =>
    entries.map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  );
  const locked = p.disabled || p.readOnly;
  const valueType = isRecord(p.schema.additionalProperties)
    ? typeOf(p.schema.additionalProperties)
    : undefined;
  const emit = (next: [string, string][]) => {
    setRows(next);
    const out: Record<string, unknown> = {};
    for (const [k, v] of next) {
      if (!k) continue;
      if (valueType === 'string') out[k] = v;
      else
        try {
          out[k] = JSON.parse(v) as unknown;
        } catch {
          out[k] = v;
        }
    }
    p.onChange(Object.keys(out).length ? out : undefined);
  };
  return (
    <Fieldset data-size="sm" className="sf-field sf-map" aria-describedby={describedBy(p)}>
      <Fieldset.Legend>{p.label}</Fieldset.Legend>
      {p.help || p.note ? (
        <Fieldset.Description id={`${p.id}-help`}>
          {[p.help, p.note].filter(Boolean).join(' ')}
        </Fieldset.Description>
      ) : null}
      {rows.map(([k, v], i) => (
        <div key={i} className="sf-map-row">
          <Field data-size="sm">
            <Label htmlFor={i === 0 ? p.id : `${p.id}-${i}-key`}>
              {t('schemaForm.key')} {i + 1}
            </Label>
            <Input
              id={i === 0 ? p.id : `${p.id}-${i}-key`}
              disabled={p.disabled}
              readOnly={p.readOnly}
              value={k}
              onChange={(e) => emit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
            />
          </Field>
          <Field data-size="sm">
            <Label htmlFor={`${p.id}-${i}-value`}>
              {t('schemaForm.value')} {i + 1}
            </Label>
            <Input
              id={`${p.id}-${i}-value`}
              disabled={p.disabled}
              readOnly={p.readOnly}
              value={v}
              onChange={(e) => emit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
            />
          </Field>
          {locked ? null : (
            <Button
              variant="tertiary"
              data-size="sm"
              data-color="danger"
              onClick={() => emit(rows.filter((_, j) => j !== i))}
            >
              {t('schemaForm.remove', { label: k || `${t('schemaForm.key')} ${i + 1}` })}
            </Button>
          )}
        </div>
      ))}
      {locked ? null : (
        <div>
          <Button
            variant="secondary"
            data-size="sm"
            id={rows.length === 0 ? p.id : undefined}
            onClick={() => setRows([...rows, ['', '']])}
          >
            {t('schemaForm.add')}
          </Button>
        </div>
      )}
      {p.error ? <ValidationMessage id={`${p.id}-error`}>{p.error}</ValidationMessage> : null}
    </Fieldset>
  );
};

export const builtinWidgets: Record<Widget, WidgetRenderer> = {
  text: TextWidget,
  textarea: TextareaWidget,
  prompt: TextareaWidget,
  number: NumberWidget,
  toggle: ToggleWidget,
  select: SelectWidget,
  multiselect: MultiselectWidget,
  model: SelectWidget,
  dataset: SelectWidget,
  tool: SelectWidget,
  secret: SecretWidget,
  cron: CronWidget,
  code: CodeWidget,
  list: ListWidget,
  map: MapWidget,
};
