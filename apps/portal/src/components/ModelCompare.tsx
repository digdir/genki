import { Avatar, Table, Tag } from '@digdir/designsystemet-react';
import type { CatalogModel } from '../api/models';
import { differs, initialsOf } from '../models';
import type { ModelText } from './model-text';
import './model-picker.css';

export interface CompareRow {
  label: string;
  cell: (m: CatalogModel) => string;
}

export const ModelMark = ({ model, text }: { model: CatalogModel; text: ModelText }) => (
  <Avatar
    aria-hidden
    variant="square"
    data-size="sm"
    data-color="neutral"
    initials={initialsOf(model.maker, text.name(model))}
  />
);

export const ModelCompare = ({
  models,
  rows,
  text,
  withMarks = false,
}: {
  models: CatalogModel[];
  rows: CompareRow[];
  text: ModelText;
  withMarks?: boolean;
}) => (
  <div className="mc-scroll">
    <Table className="mc-compare" data-size="sm">
      <Table.Head>
        <Table.Row>
          <Table.HeaderCell scope="col">
            {withMarks ? (
              text.t('modelWords.property')
            ) : (
              <span className="visually-hidden">{text.t('modelWords.property')}</span>
            )}
          </Table.HeaderCell>
          {models.map((m) => (
            <Table.HeaderCell key={m.id} scope="col">
              {withMarks ? (
                <span className="mc-head">
                  <ModelMark model={m} text={text} />
                  <span className="mc-head-name">
                    <span>{text.name(m)}</span>
                    <span className="meta">{text.maker(m)}</span>
                  </span>
                </span>
              ) : (
                text.name(m)
              )}
            </Table.HeaderCell>
          ))}
        </Table.Row>
      </Table.Head>
      <Table.Body>
        {rows.map((row) => {
          const cells = models.map(row.cell);
          const different = differs(cells);
          return (
            <Table.Row key={row.label} className={different ? 'mc-differs' : undefined}>
              <Table.HeaderCell scope="row">
                <span className="tag-row">
                  {row.label}
                  {different && withMarks ? (
                    <Tag data-size="sm" data-color="warning">
                      {text.t('modelWords.different')}
                    </Tag>
                  ) : null}
                </span>
              </Table.HeaderCell>
              {cells.map((cell, i) => (
                <Table.Cell key={models[i]?.id ?? i} className="numeric">
                  {cell}
                </Table.Cell>
              ))}
            </Table.Row>
          );
        })}
      </Table.Body>
    </Table>
  </div>
);
