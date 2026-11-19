import {
  Button,
  Card,
  Checkbox,
  Details,
  Fieldset,
  Heading,
  Link,
  Radio,
  Search,
  Select,
  Tag,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { BackLink } from '../../components/BackLink';
import { ModelCompare, ModelMark, type CompareRow } from '../../components/ModelCompare';
import {
  modelBlockHref,
  statusColor,
  useModelText,
  type ModelText,
} from '../../components/model-text';
import type { PlainKey } from '../../i18n';
import {
  catalogPageSize,
  catalogSorts,
  compareMax,
  facetValues,
  matchesQuery,
  modelStatuses,
  noSelection,
  passes,
  priceBands,
  residencies,
  sortEntries,
  unknownMaker,
  usable,
  type CatalogSort,
  type Facet,
  type ModelEntry,
  type Selection,
} from '../../models';
import type { ScreenProps } from '../../screen';
import { ErrorState, Loading } from '../../states';
import { useModelEntries } from './data';
import './models.css';

const sortKeys: Record<CatalogSort, PlainKey> = {
  recommended: 'modelCatalog.sortRecommended',
  price: 'modelCatalog.sortPrice',
  newest: 'modelCatalog.sortNewest',
};

const facetKeys: Record<Facet, PlainKey> = {
  maker: 'modelCatalog.facetMaker',
  where: 'modelCatalog.facetWhere',
  use: 'modelCatalog.facetUse',
  price: 'modelCatalog.facetPrice',
  status: 'modelCatalog.facetStatus',
};

const facets: Facet[] = ['maker', 'where', 'use', 'price', 'status'];

const priceKeys: Record<string, PlainKey> = {
  under10: 'modelCatalog.priceUnder10',
  from10to50: 'modelCatalog.priceFrom10to50',
  over50: 'modelCatalog.priceOver50',
  unpriced: 'modelCatalog.priceUnpriced',
};

const facetLabel = (text: ModelText, facet: Facet, value: string) => {
  if (facet === 'maker') return value === unknownMaker ? text.t('modelWords.unknownMaker') : value;
  if (facet === 'where') return text.where(value as ModelEntry['residency']);
  if (facet === 'use') return text.use(value);
  if (facet === 'price') return text.t(priceKeys[value] ?? 'modelCatalog.priceUnpriced');
  return text.status(value as ModelEntry['status']);
};

const valuesFor = (facet: Facet, entries: ModelEntry[]): string[] => {
  if (facet === 'where') return [...residencies];
  if (facet === 'price') return [...priceBands];
  if (facet === 'status') return [...modelStatuses];
  const seen = [...new Set(entries.flatMap((m) => facetValues(m, facet)))];
  return seen.sort((a, b) =>
    a === unknownMaker ? 1 : b === unknownMaker ? -1 : a.localeCompare(b),
  );
};

const Header = ({ text }: { text: ModelText }) => (
  <div className="mc-page-head">
    <BackLink label={text.t('blocks.title')} href="#/building-blocks" />
    <div className="mc-title-row">
      <div className="mc-intro">
        <Heading level={1} data-size="lg">
          {text.t('modelCatalog.title')}
        </Heading>
        <p className="lead">{text.t('modelCatalog.lead')}</p>
      </div>
      <Button asChild variant="secondary">
        <a href="#/building-blocks/models/in-use">{text.t('modelCatalog.inUseLink')}</a>
      </Button>
    </div>
  </div>
);

const ModelCard = ({
  m,
  text,
  compared,
  full,
  onCompare,
}: {
  m: ModelEntry;
  text: ModelText;
  compared: boolean;
  full: boolean;
  onCompare: () => void;
}) => (
  <Card
    asChild
    data-color={compared ? 'accent' : 'neutral'}
    variant={compared ? 'tinted' : 'default'}
    className="mc-card"
  >
    <li>
      <div className="mc-card-top">
        <ModelMark model={m} text={text} />
        <div className="mc-card-name">
          <Heading level={3} data-size="2xs">
            <Link href={modelBlockHref(m.id)}>{text.name(m)}</Link>
          </Heading>
          <span className="meta">{text.byLine(m)}</span>
        </div>
      </div>
      <div className="tag-row">
        {m.recommended ? (
          <Tag data-size="sm" data-color="success">
            {text.t('modelWords.recommended')}
          </Tag>
        ) : null}
        {text.uses(m).map((op) => (
          <Tag key={op} data-size="sm" data-color="neutral">
            {text.use(op)}
          </Tag>
        ))}
        <Tag data-size="sm" data-color={statusColor(m.status)}>
          {text.status(m.status)}
        </Tag>
      </div>
      <dl className="mc-facts">
        <dt>{text.t('modelCatalog.contextWindow')}</dt>
        <dd>{text.context(m)}</dd>
        <dt>{text.t('modelCatalog.pricePerMillion')}</dt>
        <dd>{text.price(m)}</dd>
        <dt>{text.t('modelCatalog.where')}</dt>
        <dd>{text.whereLong(m)}</dd>
      </dl>
      <div className="mc-card-foot">
        <Checkbox
          data-size="sm"
          label={
            <>
              {`${text.t('modelWords.compare')} `}
              <span className="visually-hidden">{text.name(m)}</span>
            </>
          }
          checked={compared}
          disabled={!compared && full}
          onChange={onCompare}
        />
        {m.status === 'requires_approval' ? (
          <Link
            href={modelBlockHref(m.id)}
            aria-label={text.t('modelWords.requestAccess', { name: text.name(m) })}
          >
            {text.t('modelWords.requestAccessShort')}
          </Link>
        ) : null}
      </div>
    </li>
  </Card>
);

export const ModelCatalog = ({ api, tenant }: ScreenProps) => {
  const text = useModelText();
  const { t } = text;
  const [state, retry, pending] = useModelEntries(api, tenant);
  const [avail, setAvail] = useState<'ours' | 'all'>('ours');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<CatalogSort>('recommended');
  const [selection, setSelection] = useState<Selection>(noSelection);
  const [limit, setLimit] = useState(catalogPageSize);
  const [compared, setCompared] = useState<string[]>([]);
  const [view, setView] = useState<'grid' | 'compare'>('grid');

  const tools = (
    <div className="mc-tools">
      <div role="search" className="mc-search">
        <label htmlFor="mc-search-field" className="ds-label">
          {t('modelCatalog.search')}
        </label>
        <Search>
          <Search.Input
            id="mc-search-field"
            placeholder={t('modelCatalog.searchPlaceholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(catalogPageSize);
            }}
          />
          <Search.Clear onClick={() => setQuery('')} />
        </Search>
      </div>
      <div className="mc-sort">
        <label htmlFor="mc-sort" className="ds-label">
          {t('modelCatalog.sortBy')}
        </label>
        <Select id="mc-sort" value={sort} onChange={(e) => setSort(e.target.value as CatalogSort)}>
          {catalogSorts.map((s) => (
            <Select.Option key={s} value={s}>
              {t(sortKeys[s])}
            </Select.Option>
          ))}
        </Select>
      </div>
    </div>
  );

  if (state.status === 'loading')
    return (
      <div className="stack">
        <Header text={text} />
        <div className="mc-layout">
          <aside aria-labelledby="mc-filters-h" className="mc-filters">
            <div className="mc-filters-head">
              <Heading level={2} data-size="xs" id="mc-filters-h">
                {t('modelCatalog.filters')}
              </Heading>
            </div>
            <ul className="mc-filter-frame">
              {[t('modelCatalog.availability'), ...facets.map((facet) => t(facetKeys[facet]))].map(
                (label) => (
                  <li key={label}>{label}</li>
                ),
              )}
            </ul>
          </aside>
          <section aria-labelledby="mc-results-h" className="mc-results">
            <h2 id="mc-results-h" className="visually-hidden">
              {t('modelCatalog.results')}
            </h2>
            {tools}
            <Loading label={t('modelWords.loading')} shape="cards" rows={6} onRetry={retry} />
          </section>
        </div>
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="stack">
        <Header text={text} />
        <ErrorState error={state.error} onRetry={retry} />
      </div>
    );

  const entries = state.data.entries;
  const words = (m: ModelEntry) => [text.where(m.residency)];
  const base = (m: ModelEntry) => (avail === 'all' || usable(m)) && matchesQuery(m, query, words);
  const shownAll = sortEntries(
    entries.filter((m) => base(m) && passes(m, selection)),
    sort,
  );
  const shown = shownAll.slice(0, limit);
  const picked = compared
    .map((id) => entries.find((m) => m.id === id))
    .filter((m): m is ModelEntry => !!m);
  const anyFilter =
    avail !== 'ours' || query.trim() !== '' || Object.values(selection).some((v) => v.length);
  const resetAll = () => {
    setAvail('ours');
    setQuery('');
    setSelection(noSelection());
    setLimit(catalogPageSize);
  };
  const toggle = (facet: Facet, value: string) => {
    setSelection((s) => ({
      ...s,
      [facet]: s[facet].includes(value)
        ? s[facet].filter((v) => v !== value)
        : [...s[facet], value],
    }));
    setLimit(catalogPageSize);
  };
  const rows: CompareRow[] = [
    { label: t('modelWords.rowMaker'), cell: text.maker },
    {
      label: t('modelWords.rowOperator'),
      cell: (m) => text.operator(m) || t('modelWords.notStated'),
    },
    { label: t('modelWords.rowWhere'), cell: (m) => text.where(m.residency) },
    { label: t('modelWords.rowUses'), cell: (m) => text.uses(m).map(text.use).join(', ') },
    { label: t('modelWords.rowContext'), cell: text.context },
    { label: t('modelWords.rowPrice'), cell: text.price },
    { label: t('modelWords.rowCapabilities'), cell: text.capabilities },
    {
      label: t('modelWords.rowStatus'),
      cell: (m) => text.status((m as ModelEntry).status),
    },
  ];

  if (view === 'compare')
    return (
      <div className="stack">
        <Header text={text} />
        <section aria-labelledby="mc-compare-h" className="stack-sm">
          <div className="mc-title-row">
            <Heading level={2} data-size="md" id="mc-compare-h">
              {t('modelCatalog.compareModels')}
            </Heading>
            <Button variant="secondary" onClick={() => setView('grid')}>
              {t('modelCatalog.backToCatalog')}
            </Button>
          </div>
          <p className="meta">{t('modelCatalog.differentRows')}</p>
          <ModelCompare models={picked} rows={rows} text={text} withMarks />
          <p className="meta">{t('modelCatalog.pickInService')}</p>
        </section>
      </div>
    );

  return (
    <div className="stack">
      <Header text={text} />
      <div className="mc-layout">
        <aside aria-labelledby="mc-filters-h" className="mc-filters">
          <div className="mc-filters-head">
            <Heading level={2} data-size="xs" id="mc-filters-h">
              {t('modelCatalog.filters')}
            </Heading>
            {anyFilter ? (
              <Button variant="tertiary" data-size="sm" onClick={resetAll}>
                {t('modelCatalog.reset')}
              </Button>
            ) : null}
          </div>
          <Details defaultOpen>
            <Details.Summary>{t('modelCatalog.availability')}</Details.Summary>
            <Details.Content>
              <Fieldset data-size="sm">
                <Fieldset.Legend className="visually-hidden">
                  {t('modelCatalog.availability')}
                </Fieldset.Legend>
                <Radio
                  name="mc-avail"
                  label={
                    <span className="mc-option">
                      <span>{t('modelCatalog.availableForUs')}</span>{' '}
                      <span className="meta numeric">{entries.filter(usable).length}</span>
                    </span>
                  }
                  checked={avail === 'ours'}
                  onChange={() => setAvail('ours')}
                />
                <Radio
                  name="mc-avail"
                  label={
                    <span className="mc-option">
                      <span>{t('modelCatalog.allModels')}</span>{' '}
                      <span className="meta numeric">{entries.length}</span>
                    </span>
                  }
                  checked={avail === 'all'}
                  onChange={() => setAvail('all')}
                />
              </Fieldset>
            </Details.Content>
          </Details>
          {facets.map((facet) => (
            <Details key={facet} defaultOpen={facet !== 'price' && facet !== 'status'}>
              <Details.Summary>{t(facetKeys[facet])}</Details.Summary>
              <Details.Content>
                <Fieldset data-size="sm">
                  <Fieldset.Legend className="visually-hidden">
                    {t(facetKeys[facet])}
                  </Fieldset.Legend>
                  {valuesFor(facet, entries).map((value) => {
                    const count = entries.filter(
                      (m) =>
                        base(m) &&
                        passes(m, selection, facet) &&
                        facetValues(m, facet).includes(value),
                    ).length;
                    return (
                      <Checkbox
                        key={value}
                        label={
                          <span className="mc-option">
                            <span>{facetLabel(text, facet, value)}</span>{' '}
                            <span className="meta numeric">{count}</span>
                          </span>
                        }
                        checked={selection[facet].includes(value)}
                        onChange={() => toggle(facet, value)}
                      />
                    );
                  })}
                </Fieldset>
              </Details.Content>
            </Details>
          ))}
        </aside>
        <section aria-labelledby="mc-results-h" className="mc-results">
          <h2 id="mc-results-h" className="visually-hidden">
            {t('modelCatalog.results')}
          </h2>
          {tools}
          <p role="status" className="mc-count">
            {avail === 'ours'
              ? t('modelCatalog.showingOurs', { shown: shown.length, total: shownAll.length })
              : t('modelCatalog.showing', { shown: shown.length, total: shownAll.length })}
          </p>
          {shown.length ? (
            <ul className="mc-grid" aria-busy={pending || undefined}>
              {shown.map((m) => (
                <ModelCard
                  key={m.id}
                  m={m}
                  text={text}
                  compared={compared.includes(m.id)}
                  full={compared.length >= compareMax}
                  onCompare={() =>
                    setCompared((c) =>
                      c.includes(m.id) ? c.filter((x) => x !== m.id) : [...c, m.id],
                    )
                  }
                />
              ))}
            </ul>
          ) : (
            <div className="mc-none">
              <strong>{t('modelCatalog.noneTitle')}</strong>
              <span>{t('modelCatalog.noneBody')}</span>
              <Button variant="secondary" className="mc-start" onClick={resetAll}>
                {t('modelCatalog.resetFilters')}
              </Button>
            </div>
          )}
          {shownAll.length > shown.length ? (
            <div className="mc-more">
              <span className="meta">
                {t('modelCatalog.moreText', {
                  shown: shown.length,
                  total: shownAll.length,
                  size: catalogPageSize,
                })}
              </span>
              <Button variant="secondary" onClick={() => setLimit((l) => l + catalogPageSize)}>
                {t('modelCatalog.showMore')}
              </Button>
            </div>
          ) : null}
        </section>
      </div>
      {picked.length ? (
        <div role="region" aria-label={t('modelCatalog.comparison')} className="mc-compare-bar">
          <span className="mc-compare-names">
            <strong>
              {t('modelCatalog.chosenCount', { count: picked.length, max: compareMax })}
            </strong>{' '}
            {picked.map((m) => text.name(m)).join(', ')}
          </span>
          <Button variant="tertiary" onClick={() => setCompared([])}>
            {t('modelCatalog.clear')}
          </Button>
          <Button
            variant="primary"
            aria-disabled={picked.length < 2}
            onClick={() => picked.length >= 2 && setView('compare')}
          >
            {t('modelCatalog.compareModels')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
