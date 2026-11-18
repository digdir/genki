import { Button, Field, Heading, Input, Label, Paragraph, Tag } from '@digdir/designsystemet-react';
import type { Format } from '@genai/i18n';
import { useFormat } from '@genai/i18n/react';
import { useId, type ReactNode } from 'react';
import type { ApiClient } from '../../api';
import type { BlockKind, CatalogItem, CatalogProposal } from '../../api/building-blocks';
import { DataLocationTag } from '../../components/DataLocationTag';
import { statusLabels } from '../../data/building-blocks';
import { useT } from '../../i18n';
import { ErrorState } from '../../states';
import {
  homeHrefs,
  homeKinds,
  homePlaces,
  typeCardHref,
  typeKeys,
  typeNames,
  typeOf,
  typePurposes,
  type TypeKey,
} from './block-types';
import { openProposals, proposalType, useItemHref } from './BlockList';
import { ReadOnlyAlert, useBlockRights } from './common';

export const OverviewHeader = ({ tenantName }: { tenantName: string }) => {
  const t = useT();
  const rights = useBlockRights();
  return (
    <>
      <div className="bb-page-head">
        <div className="bb-intro">
          <Heading level={1} data-size="lg">
            {t('blocks.title')}
          </Heading>
          <p className="lead">{t('blockTypes.overviewLead', { tenant: tenantName })}</p>
        </div>
        {rights.canRegister ? (
          <Button asChild variant="secondary">
            <a href="#/building-blocks/new">{t('blockPages.register')}</a>
          </Button>
        ) : null}
      </div>
      {rights.readOnly ? <ReadOnlyAlert /> : null}
    </>
  );
};

export const SearchAll = ({ q, onQuery }: { q: string; onQuery: (q: string) => void }) => {
  const t = useT();
  const id = useId();
  return (
    <form role="search" className="bb-search-all" onSubmit={(e) => e.preventDefault()}>
      <Field>
        <Label htmlFor={id} className="visually-hidden">
          {t('blockTypes.searchAll')}
        </Label>
        <Input
          id={id}
          type="search"
          placeholder={t('blockTypes.searchAllPlaceholder')}
          value={q}
          onChange={(e) => onQuery(e.target.value)}
        />
      </Field>
    </form>
  );
};

const countText = (t: ReturnType<typeof useT>, inUse: number, catalogue: number, required = 0) => {
  if (required)
    return catalogue
      ? t('blockTypes.countBothRequired', { inUse, required, catalogue })
      : t('blockTypes.countInUseRequired', { count: inUse, required });
  return inUse && catalogue
    ? t('blockTypes.countBoth', { inUse, catalogue })
    : inUse
      ? t('blockTypes.countInUse', { count: inUse })
      : catalogue
        ? t('blockTypes.countCatalogue', { count: catalogue })
        : t('blockTypes.countNone');
};

const purposeOf = (t: ReturnType<typeof useT>, f: Format, key: TypeKey, ofType: CatalogItem[]) => {
  if (key !== 'tool') return t(typePurposes[key]);
  const names = ofType.filter((b) => b.status === 'in_use').map((b) => b.name);
  return names.length
    ? t('blockTypes.purposeToolNamed', { names: f.list(names.slice(0, 2)) })
    : t(typePurposes[key]);
};

const TypeCard = ({
  href,
  name,
  purpose,
  meta,
  waiting = 0,
  own = false,
}: {
  href: string;
  name: string;
  purpose: string;
  meta: string;
  waiting?: number;
  own?: boolean;
}) => {
  const t = useT();
  return (
    <li>
      <a href={href} className={own ? 'bb-type-card bb-type-card-home' : 'bb-type-card'}>
        <span className="bb-type-name">
          <strong>{name}</strong>
          {waiting ? (
            <Tag data-size="sm" data-color="warning">
              {t('blockTypes.waiting', { count: waiting })}
            </Tag>
          ) : null}
        </span>
        <span className="bb-card-desc">{purpose}</span>
        <span className="bb-meta">{meta}</span>
      </a>
    </li>
  );
};

const Results = ({
  api,
  tenant,
  items,
  q,
  onQuery,
}: {
  api: ApiClient;
  tenant: string;
  items: CatalogItem[];
  q: string;
  onQuery: (q: string) => void;
}) => {
  const t = useT();
  const headingId = useId();
  const { hrefOf } = useItemHref(api, tenant);
  const wanted = q.trim().toLowerCase();
  const hits = items.filter((b) => `${b.name} ${b.description}`.toLowerCase().includes(wanted));
  return (
    <section aria-labelledby={headingId} className="stack-sm">
      <Heading level={2} data-size="xs" id={headingId}>
        {t('blockTypes.resultsHeading')}
      </Heading>
      <p aria-live="polite" className="bb-count">
        {t('blockTypes.resultsCount', { count: hits.length })}
      </p>
      {hits.length === 0 ? (
        <div className="stack-sm bb-no-hits">
          <Paragraph>{t('blockTypes.noResults')}</Paragraph>
          <Button variant="secondary" data-size="sm" onClick={() => onQuery('')}>
            {t('blockTypes.resetSearch')}
          </Button>
        </div>
      ) : (
        <ul className="bb-rows">
          {hits.map((b) => {
            const status = statusLabels[b.status];
            return (
              <li key={`${b.kind}:${b.id}`} className="bb-row">
                <div className="bb-row-main">
                  <div className="bb-row-head">
                    <a className="bb-card-name" href={hrefOf(b)}>
                      {b.name}
                    </a>
                    <Tag data-size="sm" data-color={status.color}>
                      {t(status.label)}
                    </Tag>
                    {b.dataLocation ? <DataLocationTag location={b.dataLocation} /> : null}
                  </div>
                  <span className="bb-card-desc">{b.description}</span>
                  <span className="bb-meta">
                    {t('blocks.kindFrom', {
                      kind: t(typeNames[typeOf(b)]),
                      publisher: b.publisher.name,
                    })}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export const OverviewBody = ({
  api,
  tenant,
  items,
  required = {},
  proposals,
  partialError,
  q,
  onQuery,
  refreshing = false,
}: {
  api: ApiClient;
  tenant: string;
  items: CatalogItem[];
  required?: Partial<Record<BlockKind, number>>;
  proposals: CatalogProposal[];
  partialError?: { error: unknown; retry: () => void } | undefined;
  q: string;
  onQuery: (q: string) => void;
  refreshing?: boolean;
}) => {
  const t = useT();
  const f = useFormat();
  const ids = { types: useId(), own: useId() };
  const open = openProposals(proposals);
  const waitingFor = (key: TypeKey) =>
    open.filter((p) => proposalType(p) === key).length +
    items.filter((b) => typeOf(b) === key && b.status === 'pending_approval').length;
  const shownTypes = typeKeys.filter((key) => key !== 'extension_point');

  let body: ReactNode;
  if (q.trim()) body = <Results api={api} tenant={tenant} items={items} q={q} onQuery={onQuery} />;
  else
    body = (
      <>
        <section aria-labelledby={ids.types} className="stack-sm">
          <Heading level={2} data-size="sm" id={ids.types}>
            {t('blockTypes.typesHeading')}
          </Heading>
          <ul className="bb-type-grid">
            {shownTypes.map((key) => {
              const ofType = items.filter((b) => typeOf(b) === key);
              const inUse = ofType.filter((b) => b.status === 'in_use').length;
              return (
                <TypeCard
                  key={key}
                  href={typeCardHref(key)}
                  name={t(typeNames[key])}
                  purpose={purposeOf(t, f, key, ofType)}
                  meta={
                    key === 'step_type'
                      ? t('blockTypes.fromDigdir')
                      : countText(t, inUse, ofType.length - inUse, required[key as BlockKind] ?? 0)
                  }
                  waiting={waitingFor(key)}
                />
              );
            })}
          </ul>
        </section>
        <section aria-labelledby={ids.own} className="stack-sm">
          <div className="bb-stack-xs">
            <Heading level={2} data-size="sm" id={ids.own}>
              {t('blockTypes.ownPlaceHeading')}
            </Heading>
            <p className="bb-meta">{t('blockTypes.ownPlaceLead')}</p>
          </div>
          <ul className="bb-type-grid">
            {homeKinds.map((kind) => (
              <TypeCard
                key={kind}
                own
                href={homeHrefs[kind]}
                name={t(typeNames[kind])}
                purpose={t(typePurposes[kind])}
                meta={t('blockTypes.opensIn', { place: t(homePlaces[kind]) })}
              />
            ))}
          </ul>
        </section>
      </>
    );

  return (
    <div className="stack refreshing" aria-busy={refreshing || undefined}>
      {partialError ? <ErrorState error={partialError.error} onRetry={partialError.retry} /> : null}
      {body}
    </div>
  );
};

export const BlocksOverview = (
  props: Parameters<typeof OverviewBody>[0] & { tenantName: string },
) => (
  <div className="stack">
    <OverviewHeader tenantName={props.tenantName} />
    <SearchAll q={props.q} onQuery={props.onQuery} />
    <OverviewBody {...props} />
  </div>
);
