import { createContext, useContext, useState } from 'react';
import { Button, Fieldset, Textfield } from '@digdir/designsystemet-react';
import {
  SchemaForm,
  useSchema,
  useSchemaFormSettings,
  type WidgetRenderer,
} from '@genai/schema-forms';
import type { BlockDef, ParamDef } from '../../data/stepflows';
import { useT } from '../../i18n';
import { SelectField, type Option } from './fields';

type Values = Record<string, unknown>;

interface Column {
  key: string;
  label: string;
  from: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asText = (v: unknown) =>
  v === undefined || v === null
    ? ''
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v, null, 2);

const columnsOf = (v: unknown): Column[] =>
  Array.isArray(v)
    ? v.map((c) =>
        isRecord(c)
          ? { key: asText(c.key), label: asText(c.label), from: asText(c.from) }
          : { key: '', label: '', from: '' },
      )
    : [];

const otherSource = '__other';

const ColumnsField = ({
  param,
  value,
  sources,
  onChange,
}: {
  param: ParamDef;
  value: unknown;
  sources: Option[];
  onChange: (columns: Column[]) => void;
}) => {
  const t = useT();
  const columns = columnsOf(value);
  const [custom, setCustom] = useState<string[]>([]);
  const set = (i: number, patch: Partial<Column>) =>
    onChange(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const pick = (i: number, from: string) => {
    const key = columns[i]?.key ?? '';
    setCustom((list) => (from === otherSource ? [...list, key] : list.filter((k) => k !== key)));
    set(i, { from: from === otherSource ? '' : from });
  };
  const move = (i: number, by: number) => {
    const next = [...columns];
    const [moved] = next.splice(i, 1);
    if (moved) next.splice(i + by, 0, moved);
    onChange(next);
  };
  return (
    <Fieldset data-size="sm">
      <Fieldset.Legend>{param.label}</Fieldset.Legend>
      <ol className="column-list">
        {columns.map((c, i) => {
          const name = c.label || c.key || t('stepflows.columnN', { n: i + 1 });
          const listed = sources.some((o) => o.value === c.from);
          const free = !sources.length || custom.includes(c.key) || (c.from !== '' && !listed);
          return (
            <li key={i} className="column-card">
              <div className="column-grid">
                <Textfield
                  id={`kol-${i}-key`}
                  data-size="sm"
                  label={t('stepflows.columnKey')}
                  value={c.key}
                  aria-invalid={c.key ? undefined : true}
                  onChange={(e) => set(i, { key: e.target.value.replace(/[^\w-]/g, '') })}
                />
                <Textfield
                  id={`kol-${i}-label`}
                  data-size="sm"
                  label={t('stepflows.columnName')}
                  value={c.label}
                  aria-invalid={c.label ? undefined : true}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
                {sources.length ? (
                  <SelectField
                    id={`kol-${i}-from`}
                    size="sm"
                    label={t('stepflows.valueFrom')}
                    value={free ? otherSource : c.from}
                    placeholder={t('stepflows.choose')}
                    options={[...sources, { value: otherSource, label: t('stepflows.otherValue') }]}
                    {...(c.from || free ? {} : { error: t('stepflows.chooseSource') })}
                    onChange={(from) => pick(i, from)}
                  />
                ) : null}
                {free ? (
                  <Textfield
                    id={`kol-${i}-path`}
                    data-size="sm"
                    label={sources.length ? t('stepflows.pathTo') : t('stepflows.valueFrom')}
                    description={t('stepflows.pathHelp')}
                    value={c.from}
                    aria-invalid={c.from ? undefined : true}
                    onChange={(e) => set(i, { from: e.target.value.trim() })}
                  />
                ) : null}
              </div>
              <div className="row-wrap">
                <Button
                  variant="tertiary"
                  data-size="sm"
                  aria-label={t('stepflows.moveUpLabel', { name })}
                  aria-disabled={i === 0 || undefined}
                  onClick={() => i > 0 && move(i, -1)}
                >
                  {t('stepflows.moveUp')}
                </Button>
                <Button
                  variant="tertiary"
                  data-size="sm"
                  aria-label={t('stepflows.moveDownLabel', { name })}
                  aria-disabled={i === columns.length - 1 || undefined}
                  onClick={() => i < columns.length - 1 && move(i, 1)}
                >
                  {t('stepflows.moveDown')}
                </Button>
                <Button
                  variant="tertiary"
                  data-size="sm"
                  data-color="danger"
                  aria-label={t('stepflows.removeLabel', { name })}
                  onClick={() => onChange(columns.filter((_, j) => j !== i))}
                >
                  {t('stepflows.remove')}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <div>
        <Button
          variant="secondary"
          data-size="sm"
          onClick={() => onChange([...columns, { key: '', label: '', from: '' }])}
        >
          {t('stepflows.addColumn')}
        </Button>
      </div>
    </Fieldset>
  );
};

const ColumnSources = createContext<Option[]>([]);

const ColumnsWidget: WidgetRenderer = (p) => <ColumnsWidgetView {...p} />;

const ColumnsWidgetView = (p: Parameters<WidgetRenderer>[0]) => {
  const sources = useContext(ColumnSources);
  return (
    <ColumnsField
      param={{ name: p.path, type: 'columns', label: p.label }}
      value={p.value}
      sources={sources}
      onChange={(list) => p.onChange(list.length ? list : undefined)}
    />
  );
};

export const ParamFields = ({
  block,
  values,
  columnSources = [],
  onChange,
}: {
  block: BlockDef;
  values: Values;
  columnSources?: Option[];
  onChange: (values: Values) => void;
}) => {
  const { fetchJson } = useSchemaFormSettings();
  const served = useSchema(fetchJson, block.schemaRef);
  const schema = served.status === 'ready' ? served.data : (block.paramsSchema ?? {});
  const labels = Object.fromEntries(block.params.map((p) => [p.name, p]));
  return (
    <ColumnSources.Provider value={columnSources}>
      <SchemaForm
        schema={schema}
        value={values}
        onChange={onChange}
        showErrors
        summary={false}
        idPrefix="p"
        labelFor={(path) => labels[path]?.label}
        widgets={Object.fromEntries(
          block.params.filter((p) => p.type === 'columns').map((p) => [p.name, ColumnsWidget]),
        )}
      />
    </ColumnSources.Provider>
  );
};
