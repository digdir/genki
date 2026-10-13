import {
  ErrorSummary,
  ErrorSummaryHeading,
  ErrorSummaryItem,
  ErrorSummaryLink,
  ErrorSummaryList,
  Fieldset,
  Switch,
} from '@digdir/designsystemet-react';
import { useLocale } from '@genai/i18n/react';
import { useEffect, useId, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { SchemaFormProvider, useSchemaFormSettings, type SchemaFormSettings } from './context.js';
import { useT, type T } from './i18n.js';
import {
  childrenOf,
  chosenVariant,
  discriminatorField,
  getAt,
  variantsOf,
  withoutProperty,
  helpOf,
  isGroup,
  labelOf,
  nonNull,
  resolveText,
  sectionsOf,
  setAt,
  shown,
  widgetOf,
  type FieldNode,
  type UiSchema,
  type Value,
} from './schema.js';
import { validate, type Issue, type Issues } from './validate.js';
import { useSchema } from './schemas.js';
import type { SchemaUse } from './schema.js';
import { builtinWidgets, type WidgetRenderer } from './widgets.js';

const simple = {
  required: 'schemaForm.required',
  number: 'schemaForm.number',
  integer: 'schemaForm.integer',
  pattern: 'schemaForm.pattern',
  option: 'schemaForm.option',
  json: 'schemaForm.json',
  cron: 'schemaForm.cron',
} as const;

export const issueText = (t: T, issue: Issue, label: string) => {
  switch (issue.code) {
    case 'server':
      return issue.message;
    case 'min':
      return t('schemaForm.min', { label, min: issue.min });
    case 'max':
      return t('schemaForm.max', { label, max: issue.max });
    case 'minLength':
      return t('schemaForm.minLength', { label, min: issue.min });
    case 'maxLength':
      return t('schemaForm.maxLength', { label, max: issue.max });
    default:
      return t(simple[issue.code], { label });
  }
};

export const fieldId = (prefix: string, path: string) =>
  `${prefix}-${path.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

export interface SchemaFormProps extends SchemaFormSettings {
  schema: UiSchema;
  value: Value;
  onChange?: (value: Value) => void;
  issues?: Issues;
  showErrors?: boolean;
  attempt?: number;
  disabled?: boolean;
  idPrefix?: string;
  widgets?: Record<string, WidgetRenderer>;
  labelFor?: (path: string) => string | undefined;
  only?: string[];
  uses?: SchemaUse[];
  after?: (path: string) => ReactNode;
  summary?: boolean;
  legend?: ReactNode;
}

const lockOf = (
  schema: UiSchema,
  settings: SchemaFormSettings,
  t: T,
): { disabled: boolean; readOnly: boolean; note: string | undefined } => {
  if (schema['x-readOnly'])
    return { disabled: false, readOnly: true, note: t('schemaForm.readOnly') };
  if (schema['x-operator'] && !settings.operator)
    return { disabled: true, readOnly: false, note: t('schemaForm.operatorOnly') };
  const right = schema['x-right'];
  if (right && settings.can && !settings.can(right))
    return {
      disabled: true,
      readOnly: false,
      note: t('schemaForm.needsRight', { right: settings.rightLabel?.(right) ?? right }),
    };
  const layers = schema['x-settableAt'];
  if (settings.layer && layers && !layers.includes(settings.layer))
    return { disabled: true, readOnly: false, note: t('schemaForm.notSettableHere') };
  return { disabled: false, readOnly: false, note: undefined };
};

const unitLabel = (t: T, label: string, schema: UiSchema, locale: 'nb' | 'en') => {
  const unit = resolveText(schema['x-unit'], locale);
  return unit ? t('schemaForm.unit', { label, unit }) : label;
};

const shownDefault = (t: T, schema: UiSchema, locale: 'nb' | 'en') => {
  const v = schema.default;
  if (v === undefined || schema['x-sensitive']) return undefined;
  if (typeof v === 'boolean') return t(v ? 'schemaForm.on' : 'schemaForm.off');
  if (typeof v === 'number') return String(v).replace('.', locale === 'nb' ? ',' : '.');
  if (typeof v === 'string' && v !== '') {
    const named = schema['x-enumLabels']?.[v];
    return resolveText(named, locale) ?? v;
  }
  return undefined;
};

const withDefault = (t: T, help: string | undefined, schema: UiSchema, locale: 'nb' | 'en') => {
  const value = shownDefault(t, schema, locale);
  const note = value === undefined ? undefined : t('schemaForm.defaultIs', { value });
  return [help, note].filter(Boolean).join(' ') || undefined;
};

interface Visible {
  node: FieldNode;
  label: string;
}

export const visibleFields = (
  schema: UiSchema,
  value: Value,
  locale: 'nb' | 'en',
  labelFor?: (path: string) => string | undefined,
): Visible[] => {
  const out: Visible[] = [];
  const walk = (s: UiSchema, path: string) => {
    for (const node of childrenOf(s, path)) {
      const own = nonNull(node.schema);
      if (!shown(own, value, path)) continue;
      const variants = variantsOf(own);
      if (variants) {
        const label =
          resolveText(own['x-label'], locale) ?? labelFor?.(node.path) ?? labelOf(node, locale);
        out.push({
          node: {
            ...node,
            path: `${node.path}.${variants.discriminator}`,
            schema: discriminatorField(variants),
          },
          label,
        });
        const chosen = chosenVariant(variants, getAt(value, node.path));
        if (chosen) walk(withoutProperty(chosen.schema, variants.discriminator), node.path);
      } else if (isGroup(own)) walk(own, node.path);
      else
        out.push({
          node,
          label:
            resolveText(own['x-label'], locale) ?? labelFor?.(node.path) ?? labelOf(node, locale),
        });
    }
  };
  walk(schema, '');
  return out;
};

export const SchemaForm = (props: SchemaFormProps) => {
  const t = useT();
  const { locale } = useLocale();
  const inherited = useSchemaFormSettings();
  const settings: SchemaFormSettings = {
    ...inherited,
    ...Object.fromEntries(
      (['fetchJson', 'routeParams', 'can', 'rightLabel', 'operator', 'layer'] as const)
        .filter((k) => props[k] !== undefined)
        .map((k) => [k, props[k]]),
    ),
  };
  const generated = useId();
  const prefix = props.idPrefix ?? `sf${generated.replace(/:/g, '')}`;
  const [advanced, setAdvanced] = useState(false);
  const summaryRef = useRef<ComponentRef<typeof ErrorSummary>>(null);
  const { schema, value } = props;
  const own = props.showErrors ? validate(schema, value) : {};
  const issues: Issues = { ...own, ...props.issues };
  const fields = visibleFields(schema, value, locale, props.labelFor);
  const errorsShown = fields.filter((f) => issues[f.node.path]);
  const hasAdvanced = fields.some((f) => nonNull(f.node.schema)['x-advanced']);
  const openAdvanced = advanced || errorsShown.some((f) => nonNull(f.node.schema)['x-advanced']);

  useEffect(() => {
    if (props.attempt && errorsShown.length > 0) summaryRef.current?.focus();
  }, [props.attempt]);

  const useAt = (path: string) => {
    const general = path.replace(/\.\d+(?=\.|$)/g, '');
    const parent = path.split('.').slice(0, -1).join('.');
    return props.uses?.find(
      (u) => u.at === general && (!u.when || shown({ 'x-showIf': u.when }, value, parent)),
    );
  };

  const change = (path: string, next: unknown) => props.onChange?.(setAt(value, path, next));

  const renderFields = (
    s: UiSchema,
    path: string,
    at: Value,
    onSet: (p: string, v: unknown) => void,
  ): ReactNode => {
    const nodes = childrenOf(s, path).filter((n) => {
      const ownSchema = nonNull(n.schema);
      if (!shown(ownSchema, value, path)) return false;
      if (props.only && path === '' && !props.only.includes(n.name)) return false;
      if (ownSchema['x-advanced'] && !openAdvanced) return false;
      return true;
    });
    return sectionsOf(nodes).map((section) => {
      const body = section.fields.map((node) => renderNode(node, at, onSet));
      const legend = resolveText(section.label, locale);
      return legend ? (
        <Fieldset key={section.key} data-size="sm" className="sf-group">
          <Fieldset.Legend>{legend}</Fieldset.Legend>
          {body}
        </Fieldset>
      ) : (
        body
      );
    });
  };

  const renderNode = (
    node: FieldNode,
    at: Value,
    onSet: (p: string, v: unknown) => void,
  ): ReactNode => {
    const s = nonNull(node.schema);
    const label = unitLabel(
      t,
      resolveText(s['x-label'], locale) ?? props.labelFor?.(node.path) ?? labelOf(node, locale),
      s,
      locale,
    );
    const used = useAt(node.path);
    if (used)
      return (
        <Embedded
          key={`${node.path}:${used.href}`}
          href={used.href}
          label={label}
          render={(embedded) => renderFields(embedded, node.path, at, onSet)}
        />
      );
    const variants = variantsOf(s);
    if (variants) {
      const chosen = chosenVariant(variants, getAt(at, node.path));
      const discPath = `${node.path}.${variants.discriminator}`;
      const pick = renderNode(
        {
          ...node,
          path: discPath,
          name: variants.discriminator,
          schema: discriminatorField(variants),
          group: undefined,
        },
        at,
        (_p, v) => onSet(node.path, v === undefined ? undefined : { [variants.discriminator]: v }),
      );
      return (
        <Fieldset key={node.path} data-size="sm" className="sf-group">
          <Fieldset.Legend>{label}</Fieldset.Legend>
          {helpOf(s, locale) ? (
            <Fieldset.Description>{helpOf(s, locale)}</Fieldset.Description>
          ) : null}
          {pick}
          {chosen
            ? renderFields(
                withoutProperty(chosen.schema, variants.discriminator),
                node.path,
                at,
                onSet,
              )
            : null}
          {props.after?.(node.path)}
        </Fieldset>
      );
    }
    if (isGroup(s))
      return (
        <Fieldset key={node.path} data-size="sm" className="sf-group">
          <Fieldset.Legend>{label}</Fieldset.Legend>
          {helpOf(s, locale) ? (
            <Fieldset.Description>{helpOf(s, locale)}</Fieldset.Description>
          ) : null}
          {renderFields(s, node.path, at, onSet)}
          {props.after?.(node.path)}
        </Fieldset>
      );
    const widget = widgetOf(s);
    const Render = props.widgets?.[node.path] ?? props.widgets?.[widget] ?? builtinWidgets[widget];
    const lock = lockOf(s, settings, t);
    const issue = issues[node.path];
    const local = getAt(at, node.path);
    const after = props.after?.(node.path);
    const rendered = (
      <Render
        key={node.path}
        id={fieldId(prefix, node.path)}
        path={node.path}
        label={label}
        help={withDefault(t, helpOf(s, locale), s, locale)}
        schema={s}
        widget={widget}
        value={local}
        required={node.required}
        disabled={Boolean(props.disabled) || lock.disabled}
        readOnly={lock.readOnly}
        note={lock.note}
        error={issue ? issueText(t, issue, label) : undefined}
        onChange={(v) => onSet(node.path, v)}
        renderItem={(itemSchema, itemPath, itemValue, onItem) =>
          renderFields(itemSchema, itemPath, setAt({}, itemPath, itemValue), (p, v) => {
            const rel = p.slice(itemPath.length + 1);
            onItem(setAt((itemValue ?? {}) as Value, rel, v));
          })
        }
      />
    );
    return after ? (
      <div key={node.path} className="sf-with-after">
        {rendered}
        {after}
      </div>
    ) : (
      rendered
    );
  };

  return (
    <SchemaFormProvider {...settings}>
      <div className="sf-form">
        {props.summary !== false && props.showErrors && errorsShown.length > 0 ? (
          <ErrorSummary ref={summaryRef} tabIndex={-1} data-size="sm">
            <ErrorSummaryHeading>{t('schemaForm.summaryHeading')}</ErrorSummaryHeading>
            <ErrorSummaryList>
              {errorsShown.map((f) => {
                const id = fieldId(prefix, f.node.path);
                return (
                  <ErrorSummaryItem key={f.node.path}>
                    <ErrorSummaryLink
                      href={`#${id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(id)?.focus();
                      }}
                    >
                      {issueText(t, issues[f.node.path] as Issue, f.label)}
                    </ErrorSummaryLink>
                  </ErrorSummaryItem>
                );
              })}
            </ErrorSummaryList>
          </ErrorSummary>
        ) : null}
        {props.legend ? (
          <Fieldset data-size="sm">
            <Fieldset.Legend>{props.legend}</Fieldset.Legend>
            {renderFields(schema, '', value, change)}
          </Fieldset>
        ) : (
          renderFields(schema, '', value, change)
        )}
        {hasAdvanced ? (
          <Switch
            data-size="sm"
            label={t('schemaForm.showAdvanced')}
            checked={openAdvanced}
            onChange={(e) => setAdvanced(e.target.checked)}
          />
        ) : null}
      </div>
    </SchemaFormProvider>
  );
};

const Embedded = ({
  href,
  label,
  render,
}: {
  href: string;
  label: string;
  render: (schema: UiSchema) => ReactNode;
}) => {
  const { fetchJson } = useSchemaFormSettings();
  const loaded = useSchema(fetchJson, href);
  if (loaded.status !== 'ready') return null;
  return (
    <Fieldset data-size="sm" className="sf-group">
      <Fieldset.Legend>{label}</Fieldset.Legend>
      {render(loaded.data)}
    </Fieldset>
  );
};

export const hasIssues = (schema: UiSchema, value: Value) =>
  Object.keys(validate(schema, value)).length > 0;
