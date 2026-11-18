import { Button, Heading, Paragraph } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import type { CatalogItem } from '../api/building-blocks';
import { BackLink } from '../components/BackLink';
import { HeadingSkeleton } from '../components/Skeleton';
import { findCapability, type SharedCapability } from '../data/shared-services';
import { useAsync, type AsyncState } from '../hooks';
import { modelLabel } from '../models';
import { useT, type T } from '../i18n';
import type { ScreenProps } from '../screen';
import { EmptyState, ErrorState, Loading } from '../states';
import type { ModelOption, Residency, SharedService } from '../types';
import { SharedServiceDetail } from './shared/SharedServiceDetail';
import { UsageTag } from './shared/UsageTag';
import { priceText, type SharedServiceFacts } from './shared/price';
import './shared.css';

interface Entry {
  capability: SharedCapability;
  publicName: string;
  residency: Residency | undefined;
  block: CatalogItem | undefined;
  service: SharedServiceFacts;
}

const residencyLabel = (t: T, r: Residency | undefined) =>
  r === 'norway'
    ? t('sharedServices.residencyNorway')
    : r === 'eu'
      ? t('sharedServices.residencyEu')
      : r === 'global'
        ? t('sharedServices.residencyOutside')
        : t('sharedServices.notGiven');

const processedLabel = (t: T, r: Residency | undefined) =>
  r === 'norway'
    ? t('sharedServices.processesNorway')
    : r === 'eu'
      ? t('sharedServices.processesEu')
      : r === 'global'
        ? t('sharedServices.processesOutside')
        : t('sharedServices.processesUnknown');

const residencies: readonly string[] = ['norway', 'eu', 'global'];

export const serviceResidency = (s: Pick<SharedService, 'residency'>) =>
  s.residency && residencies.includes(s.residency) ? (s.residency as Residency) : undefined;

export const sharedBlockId = (s: Pick<SharedService, 'tenant' | 'id'>) => `${s.tenant}/${s.id}`;

const fromApi = (
  t: T,
  s: SharedService,
  location: string,
  known: ModelOption[],
): SharedCapability => ({
  id: s.id,
  alias: s.id,
  tool: `digdir.${s.id}`,
  name: s.name,
  version: s.version === null ? '' : String(s.version),
  does: s.purpose,
  long: s.purpose,
  input: t('sharedServices.text'),
  output: t('sharedServices.text'),
  model: s.model ? modelLabel(s.model, known) : t('sharedServices.notGiven'),
  location,
  score: 0,
  price: '–',
  priceNote: t('sharedServices.notPriced'),
  optionLabel: t('sharedServices.option'),
  options: [t('sharedServices.standard')],
  kind: 'text',
  inputLabel: t('sharedServices.text'),
  notes: [],
  seconds: '–',
  tokens: '–',
  body: {},
});

const merge = (
  t: T,
  services: SharedServiceFacts[],
  models: AsyncState<ModelOption[]>,
  blocks: CatalogItem[],
  live: boolean,
): Entry[] =>
  services.map((s) => {
    const residency = serviceResidency(s);
    const location = residencyLabel(t, residency);
    const design = live ? undefined : findCapability(s.id);
    const api = fromApi(t, s, location, models.status === 'ready' ? models.data : []);
    return {
      capability: design
        ? { ...design, location, model: api.model, version: api.version, does: s.purpose }
        : api,
      publicName: s.variants[0]?.publicName ?? `${s.id}__default`,
      residency,
      block: blocks.find((b) => b.kind === 'shared_service' && b.id === sharedBlockId(s)),
      service: s,
    };
  });

const Card = ({ entry, meta }: { entry: Entry; meta: string }) => {
  const t = useT();
  const c = entry.capability;
  const href = `#/shared-services/${encodeURIComponent(c.id)}`;
  return (
    <li className="cap-card">
      <div className="stack-xs">
        <div className="cap-card-head">
          <h2 className="cap-card-title">
            <a href={href}>{c.name}</a>
          </h2>
          <UsageTag block={entry.block} />
        </div>
        <p className="cap-does">{c.does}</p>
        <p className="cap-meta">{meta}</p>
      </div>
      <Button
        className="cap-action"
        variant="secondary"
        aria-label={t('sharedServices.tryAndDetailsFor', { name: c.name })}
        onClick={() => {
          window.location.hash = href;
        }}
      >
        {t('sharedServices.tryAndDetails')}
      </Button>
    </li>
  );
};

export const SharedServices = ({ api, tenant, route, live }: ScreenProps) => {
  const t = useT();
  const f = useFormat();
  const [state, retry] = useAsync((signal) => api.sharedServices(signal), [api]);
  const [models, retryModels] = useAsync((signal) => api.listModels({}, signal), [api]);
  const [blocks, retryBlocks] = useAsync(
    async (signal) =>
      (await api.buildingBlocks.list(tenant, { kind: 'shared_service' }, signal)).data,
    [api, tenant],
  );
  const retryPending = () => {
    if (state.status !== 'ready') retry();
    if (models.status !== 'ready') retryModels();
    if (blocks.status !== 'ready') retryBlocks();
  };
  const id = route.segments[1];
  if (state.status === 'loading' || models.status === 'loading' || blocks.status === 'loading')
    return id ? (
      <div className="stack">
        <BackLink label={t('sharedServices.back')} href="#/shared-services" />
        <HeadingSkeleton label={t('sharedServices.loading')} />
        <Loading label={t('sharedServices.loading')} shape="detail" onRetry={retryPending} />
      </div>
    ) : (
      <>
        <Heading level={1} data-size="lg">
          {t('sharedServices.title')}
        </Heading>
        <Loading label={t('sharedServices.loading')} shape="list" onRetry={retryPending} />
      </>
    );
  if (state.status === 'error')
    return (
      <>
        <Heading level={1} data-size="lg">
          {t('sharedServices.title')}
        </Heading>
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  const entries = merge(t, state.data, models, blocks.status === 'ready' ? blocks.data : [], live);

  if (id) {
    const key = (live ? undefined : findCapability(id)?.id) ?? id;
    const entry = entries.find((e) => e.capability.id === key);
    if (!entry)
      return (
        <>
          <Heading level={1} data-size="lg">
            {t('sharedServices.notFoundTitle')}
          </Heading>
          <Paragraph>
            {t('sharedServices.notFoundBody')}{' '}
            <a href="#/shared-services">{t('sharedServices.gotoList')}</a>
          </Paragraph>
        </>
      );
    return (
      <SharedServiceDetail
        api={api}
        tenant={tenant}
        capability={entry.capability}
        publicName={entry.publicName}
        block={entry.block}
        blockId={sharedBlockId(entry.service)}
        owner={entry.service.tenant}
        price={priceText(t, f, entry.service, models)}
        service={entry.service}
      />
    );
  }

  return (
    <div className="stack">
      <div className="page-head-text">
        <Heading level={1} data-size="lg">
          {t('sharedServices.title')}
        </Heading>
        <p className="lead">{t('sharedServicesMore.lead')}</p>
      </div>
      {entries.length === 0 ? (
        <EmptyState title={t('sharedServices.emptyTitle')}>
          <Paragraph>{t('sharedServices.emptyBody')}</Paragraph>
          <a href="#/contact">{t('sharedServices.emptyLink')}</a>
        </EmptyState>
      ) : (
        <>
          <ul className="cap-grid">
            {entries.map((e) => (
              <Card
                key={e.capability.id}
                entry={e}
                meta={`${processedLabel(t, e.residency)} · ${priceText(t, f, e.service, models, true)}`}
              />
            ))}
          </ul>
          <Paragraph>
            {t('sharedServices.moreComing')} <a href="#/contact">{t('sharedServices.tellUs')}</a>
          </Paragraph>
        </>
      )}
    </div>
  );
};
