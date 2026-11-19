import {
  Alert,
  Button,
  Checkbox,
  Heading,
  Link,
  Search,
  Table,
  Tag,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { BackLink } from '../../components/BackLink';
import {
  modelBlockHref,
  statusColor,
  useModelText,
  type ModelText,
} from '../../components/model-text';
import type { PlainKey } from '../../i18n';
import {
  displayName,
  inUsePageSize,
  matchesQuery,
  modelStatuses,
  pageOf,
  residencies,
  type ModelEntry,
} from '../../models';
import type { ScreenProps } from '../../screen';
import { ErrorState, Loading } from '../../states';
import { useModelEntries } from './data';
import './models.css';

type Column = 'name' | 'maker' | 'where' | 'used' | 'price' | 'status';
const columns: Column[] = ['name', 'maker', 'where', 'used', 'price', 'status'];

const headKeys: Record<Column, PlainKey> = {
  name: 'modelsInUse.colName',
  maker: 'modelsInUse.colMaker',
  where: 'modelsInUse.colWhere',
  used: 'modelsInUse.colUsed',
  price: 'modelsInUse.colPrice',
  status: 'modelsInUse.colStatus',
};

const sortNameKeys: Record<Column, PlainKey> = {
  name: 'modelsInUse.sortName',
  maker: 'modelsInUse.sortMaker',
  where: 'modelsInUse.sortWhere',
  used: 'modelsInUse.sortUsed',
  price: 'modelsInUse.sortPrice',
  status: 'modelsInUse.sortStatus',
};

const valueOf = (m: ModelEntry, column: Column): string | number => {
  if (column === 'name') return displayName(m).toLocaleLowerCase('nb');
  if (column === 'maker') return (m.maker ?? '').toLocaleLowerCase('nb');
  if (column === 'where') return residencies.indexOf(m.residency);
  if (column === 'used') return m.usedBy.length;
  if (column === 'price') return m.price ? m.price.inputPerThousand : Infinity;
  return modelStatuses.indexOf(m.status);
};

const Header = ({ text, tenantName }: { text: ModelText; tenantName: string }) => (
  <div className="mc-page-head">
    <BackLink label={text.t('blocks.title')} href="#/building-blocks" />
    <div className="mc-title-row">
      <div className="mc-intro">
        <Heading level={1} data-size="lg">
          {text.t('modelsInUse.title')}
        </Heading>
        <p className="lead">{text.t('modelsInUse.lead', { tenant: tenantName })}</p>
      </div>
      <Button asChild variant="secondary">
        <a href="#/building-blocks/models">{text.t('modelsInUse.catalogLink')}</a>
      </Button>
    </div>
  </div>
);

export const ModelsInUse = ({ api, tenant, tenantName }: ScreenProps) => {
  const text = useModelText();
  const { t } = text;
  const [state, retry, pending] = useModelEntries(api, tenant);
  const [query, setQuery] = useState('');
  const [onlyUsed, setOnlyUsed] = useState(false);
  const [sort, setSort] = useState<{ column: Column; dir: 'asc' | 'desc' }>({
    column: 'used',
    dir: 'desc',
  });
  const [page, setPage] = useState(1);

  if (state.status !== 'ready')
    return (
      <div className="stack">
        <Header text={text} tenantName={tenantName} />
        {state.status === 'loading' ? (
          <Loading
            label={t('modelWords.loading')}
            shape="table"
            rows={inUsePageSize}
            columns={columns.map((column) => t(headKeys[column]))}
            onRetry={retry}
          />
        ) : (
          <ErrorState error={state.error} onRetry={retry} />
        )}
      </div>
    );

  const { entries, usageKnown } = state.data;
  const rows = entries
    .filter(
      (m) =>
        (!onlyUsed || m.usedBy.length > 0) &&
        matchesQuery(m, query, (x) => [text.where(x.residency), ...x.usedBy.map((u) => u.name)]),
    )
    .sort((a, b) => {
      const x = valueOf(a, sort.column);
      const y = valueOf(b, sort.column);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return (sort.dir === 'asc' ? c : -c) || displayName(a).localeCompare(displayName(b), 'nb');
    });
  const paged = pageOf(rows, page, inUsePageSize);
  const sortBy = (column: Column) => {
    setSort((s) =>
      s.column === column
        ? { column, dir: s.dir === 'desc' ? 'asc' : 'desc' }
        : { column, dir: column === 'used' ? 'desc' : 'asc' },
    );
    setPage(1);
  };

  return (
    <div className="stack">
      <Header text={text} tenantName={tenantName} />
      <div className="mc-tools">
        <div role="search" className="mc-search">
          <label htmlFor="mc-search-field" className="ds-label">
            {t('modelsInUse.search')}
          </label>
          <Search>
            <Search.Input
              id="mc-search-field"
              placeholder={t('modelsInUse.searchPlaceholder')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
            <Search.Clear onClick={() => setQuery('')} />
          </Search>
        </div>
        <Checkbox
          label={t('modelsInUse.onlyUsed')}
          checked={onlyUsed}
          onChange={() => {
            setOnlyUsed(!onlyUsed);
            setPage(1);
          }}
        />
      </div>
      {usageKnown ? null : (
        <Alert data-color="warning" data-size="sm">
          {t('modelsInUse.usageUnknown')}
        </Alert>
      )}
      <div
        className="mc-table-box"
        tabIndex={0}
        role="region"
        aria-label={t('modelsInUse.tableRegion')}
      >
        <Table className="mc-table" aria-busy={pending || undefined}>
          <caption className="visually-hidden">
            {t('modelsInUse.caption', { column: t(sortNameKeys[sort.column]) })}
          </caption>
          <Table.Head>
            <Table.Row>
              {columns.map((column) => (
                <Table.HeaderCell
                  key={column}
                  scope="col"
                  sort={
                    sort.column === column
                      ? sort.dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  onClick={() => sortBy(column)}
                >
                  {t(headKeys[column])}
                </Table.HeaderCell>
              ))}
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {paged.items.map((m) => (
              <Table.Row key={m.id}>
                <Table.HeaderCell scope="row" className="mc-nowrap">
                  <Link href={modelBlockHref(m.id)}>{text.name(m)}</Link>
                </Table.HeaderCell>
                <Table.Cell>
                  <span className="mc-cell-stack">
                    <span>{text.maker(m)}</span>
                    {text.operator(m) ? (
                      <span className="meta">
                        {t('modelsInUse.operatedBy', { operator: text.operator(m) })}
                      </span>
                    ) : null}
                  </span>
                </Table.Cell>
                <Table.Cell>
                  <Tag data-size="sm" data-color={m.residency === 'global' ? 'warning' : 'info'}>
                    {text.where(m.residency)}
                  </Tag>
                </Table.Cell>
                <Table.Cell className={m.usedBy.length ? undefined : 'meta'}>
                  {m.usedBy.length
                    ? t('modelsInUse.usedBy', {
                        count: m.usedBy.length,
                        names: m.usedBy.map((u) => u.name).join(', '),
                      })
                    : t('modelsInUse.usedByNone')}
                </Table.Cell>
                <Table.Cell className="numeric mc-nowrap">{text.price(m)}</Table.Cell>
                <Table.Cell>
                  <Tag data-size="sm" data-color={statusColor(m.status)}>
                    {text.status(m.status)}
                  </Tag>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
      <nav aria-label={t('modelsInUse.pages')} className="mc-pager">
        <span role="status" className="meta numeric">
          {rows.length
            ? t('modelsInUse.range', { from: paged.from, to: paged.to, total: rows.length })
            : t('modelsInUse.noMatch')}
        </span>
        <div className="actions">
          <Button
            variant="secondary"
            aria-disabled={paged.current === 1}
            onClick={() => paged.current > 1 && setPage(paged.current - 1)}
          >
            {t('modelsInUse.previous')}
          </Button>
          {Array.from({ length: paged.pages }, (_, i) => i + 1).map((n) => (
            <Button
              key={n}
              variant={n === paged.current ? 'primary' : 'secondary'}
              aria-current={n === paged.current ? 'page' : undefined}
              aria-label={t('modelsInUse.page', { page: n })}
              onClick={() => setPage(n)}
            >
              {n}
            </Button>
          ))}
          <Button
            variant="secondary"
            aria-disabled={paged.current === paged.pages}
            onClick={() => paged.current < paged.pages && setPage(paged.current + 1)}
          >
            {t('modelsInUse.next')}
          </Button>
        </div>
      </nav>
      <p className="meta">{t('modelsInUse.priceNote')}</p>
    </div>
  );
};
