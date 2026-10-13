import {
  Button,
  Chip,
  Field,
  Heading,
  Label,
  Paragraph,
  Radio,
  Select,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { ApiCallLink } from '../../components/ApiCall';
import { useT, type PlainKey } from '../../i18n';
import './table-output.css';
import {
  columnKeyFrom,
  columnProblems,
  tableOutputFrom,
  tableOutputSpec,
  type TableColumn,
  type TableColumnKind,
  type TableColumnType,
  type TableOutput,
} from '../../data/table-output';
import type { TableColumnSpec } from '../../data/service-definition';
import { useEditBuffer } from '../../edit-buffer';

interface Props {
  serviceId: string;
  table: TableOutput | undefined;
  onChange: (table: TableOutput) => void;
}

const columnTypes: [TableColumnType, PlainKey][] = [
  ['string', 'tableOutput.typeString'],
  ['number', 'tableOutput.typeNumber'],
  ['enum', 'tableOutput.typeEnum'],
];

const columnKinds: [TableColumnKind, PlainKey][] = [
  ['document', 'tableOutput.kindDocument'],
  ['assessment', 'tableOutput.kindAssessment'],
];

export const TableOutputEditor = ({ serviceId, table, onChange }: Props) => {
  const t = useT();
  const [flash, setFlash] = useState('');
  const columns = table?.columns ?? [];
  const rowKey = table?.rowKey ?? '';
  const problems = columnProblems(t, { columns, rowKey });
  const set = (next: TableColumn[], key = rowKey) => onChange({ columns: next, rowKey: key });
  const update = (i: number, patch: Partial<TableColumn>) => {
    const old = columns[i];
    set(
      columns.map((c, j) => (j === i ? { ...c, ...patch } : c)),
      patch.key !== undefined && old?.key === rowKey ? patch.key : rowKey,
    );
  };
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= columns.length) return;
    const next = [...columns];
    const [moved] = next.splice(i, 1);
    if (!moved) return;
    next.splice(j, 0, moved);
    set(next);
    setFlash(t('tableOutput.moved', { name: moved.name || moved.key, position: j + 1 }));
  };
  const remove = (i: number) => {
    const gone = columns[i];
    set(
      columns.filter((_c, j) => j !== i),
      gone?.key === rowKey ? '' : rowKey,
    );
    setFlash(t('tableOutput.removed', { name: gone?.name || gone?.key || '' }));
  };
  const add = () =>
    set([
      ...columns,
      {
        key: columnKeyFrom(
          t('tableOutput.newColumn'),
          columns.map((c) => c.key),
        ),
        name: t('tableOutput.newColumn'),
        type: 'string',
        desc: '',
        kind: 'document',
        values: '',
      },
    ]);

  return (
    <section aria-labelledby="kolonner-h" className="stack-xs">
      <Heading level={3} data-size="xs" id="kolonner-h">
        {t('tableOutput.columns')}
      </Heading>
      <Paragraph data-size="sm" className="meta">
        {t('tableOutput.kindsHelp')}
      </Paragraph>
      <div aria-live="polite">{flash ? <Paragraph data-size="sm">{flash}</Paragraph> : null}</div>
      {columns.length === 0 ? (
        <p className="meta field-empty">{t('tableOutput.empty')}</p>
      ) : (
        <ol className="table-columns">
          {columns.map((c, i) => {
            const name = c.name || c.key || t('tableOutput.columnN', { n: i + 1 });
            const p = problems[i];
            return (
              <li key={i} className="table-column">
                <div className="row-wrap table-column-head">
                  <strong>
                    {i + 1}. {name}
                  </strong>
                  <span className="row-wrap">
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      aria-disabled={i === 0 || undefined}
                      onClick={() => move(i, -1)}
                      aria-label={t('tableOutput.moveUpLabel', { name })}
                    >
                      {t('tableOutput.moveUp')}
                    </Button>
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      aria-disabled={i === columns.length - 1 || undefined}
                      onClick={() => move(i, 1)}
                      aria-label={t('tableOutput.moveDownLabel', { name })}
                    >
                      {t('tableOutput.moveDown')}
                    </Button>
                    <Button
                      variant="tertiary"
                      data-size="sm"
                      data-color="danger"
                      onClick={() => remove(i)}
                      aria-label={t('tableOutput.removeLabel', { name })}
                    >
                      {t('tableOutput.remove')}
                    </Button>
                  </span>
                </div>
                <div className="table-column-grid">
                  <Textfield
                    data-size="sm"
                    label={t('tableOutput.name')}
                    value={c.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                  />
                  <Textfield
                    data-size="sm"
                    label={t('tableOutput.key')}
                    value={c.key}
                    error={p?.key}
                    onChange={(e) => update(i, { key: e.target.value.trim() })}
                  />
                  <Field data-size="sm">
                    <Label htmlFor={`kolonne-type-${i}`}>{t('tableOutput.type')}</Label>
                    <Select
                      id={`kolonne-type-${i}`}
                      value={c.type}
                      onChange={(e) => update(i, { type: e.target.value as TableColumnType })}
                    >
                      {columnTypes.map(([id, label]) => (
                        <Select.Option key={id} value={id}>
                          {t(label)}
                        </Select.Option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Textfield
                  data-size="sm"
                  label={t('tableOutput.description')}
                  description={t('tableOutput.descriptionHelp')}
                  value={c.desc}
                  onChange={(e) => update(i, { desc: e.target.value })}
                />
                <fieldset className="plain-fieldset">
                  <legend className="ds-label">{t('tableOutput.kind')}</legend>
                  <div className="tag-row">
                    {columnKinds.map(([id, label]) => (
                      <Chip.Radio
                        key={id}
                        name={`kolonne-slag-${i}`}
                        checked={c.kind === id}
                        onChange={() => update(i, { kind: id })}
                      >
                        {t(label)}
                      </Chip.Radio>
                    ))}
                  </div>
                </fieldset>
                {c.kind === 'assessment' || c.type === 'enum' ? (
                  <Textfield
                    data-size="sm"
                    label={t('tableOutput.values')}
                    value={c.values}
                    error={p?.values}
                    onChange={(e) => update(i, { values: e.target.value })}
                  />
                ) : null}
                <Radio
                  name="kolonne-rad-id"
                  label={t('tableOutput.rowKey')}
                  checked={rowKey !== '' && rowKey === c.key}
                  onChange={() => set(columns, c.key)}
                />
              </li>
            );
          })}
        </ol>
      )}
      <Button variant="secondary" data-size="sm" className="align-start" onClick={add}>
        {t('tableOutput.add')}
      </Button>
      <ApiCallLink
        call={{
          action: t('tableOutput.saveAction'),
          method: 'POST',
          path: '/definitions',
          body: {
            definition: {
              kind: 'Service',
              metadata: { id: serviceId },
              spec: { output: { kind: 'table', ...tableOutputSpec({ columns, rowKey }) } },
            },
          },
          right: t('tableOutput.right'),
        }}
      />
    </section>
  );
};

export interface TableSpec {
  columns?: TableColumnSpec[] | undefined;
  rowKey?: string | undefined;
}

export const TableColumnsEditor = ({
  serviceId,
  table,
  onChange,
}: {
  serviceId: string;
  table: TableSpec;
  onChange: (table: TableSpec) => void;
}) => {
  const [buffer, setBuffer] = useEditBuffer<TableOutput | undefined, TableSpec>(
    { columns: table.columns, rowKey: table.rowKey },
    (slice) => tableOutputFrom({ ...slice }),
    (form) => ({ columns: undefined, rowKey: undefined, ...tableOutputSpec(form) }),
    onChange,
  );
  return <TableOutputEditor serviceId={serviceId} table={buffer} onChange={setBuffer} />;
};
