import { Button, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { findCapability, type SharedCapability } from '../data/shared-services';
import { useAsync, type AsyncState } from '../hooks';
import { modelLabel } from '../models';
import { useT, type T } from '../i18n';
import type { ScreenProps } from '../screen';
import { EmptyState, ErrorState, Loading } from '../states';
import type { ModelOption, Residency, SharedService } from '../types';
import { SharedServiceDetail } from './shared/SharedServiceDetail';
import './shared.css';

interface Entry {
  capability: SharedCapability;
  publicName: string;
  residency: Residency | undefined;
}

const residencyLabel = (t: T, r: Residency | undefined, models: AsyncState<ModelOption[]>) =>
  r === 'norway'
    ? t('sharedServices.residencyNorway')
    : r === 'eu'
      ? t('sharedServices.residencyEu')
      : r === 'global'
        ? t('sharedServices.residencyOutside')
        : models.status === 'error'
          ? t('sharedServices.residencyUnavailable')
          : t('sharedServices.notGiven');

const residencyColors = { norway: 'success', eu: 'info', global: 'warning' } as const;

export const modelResidency = (model: string | null | undefined, models: ModelOption[]) =>
  model ? models.find((m) => m.id === model)?.residency : undefined;

const fromApi = (t: T, s: SharedService, location: string): SharedCapability => ({
  id: s.id,
  alias: s.id,
  tool: `digdir.${s.id}`,
  name: s.name,
  version: s.version === null ? '' : String(s.version),
  does: s.purpose,
  long: s.purpose,
  input: t('sharedServices.text'),
  output: t('sharedServices.text'),
  model: s.model ? modelLabel(s.model) : t('sharedServices.notGiven'),
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
  services: SharedService[],
  models: AsyncState<ModelOption[]>,
  live: boolean,
): Entry[] =>
  services.map((s) => {
    const residency = modelResidency(s.model, models.status === 'ready' ? models.data : []);
    const location = residencyLabel(t, residency, models);
    const design = live ? undefined : findCapability(s.id);
    return {
      capability: design ? { ...design, location } : fromApi(t, s, location),
      publicName: s.variants[0]?.publicName ?? `${s.id}__default`,
      residency,
    };
  });

const Card = ({ entry: { capability: c, residency } }: { entry: Entry }) => {
  const t = useT();
  const href = `#/shared-services/${encodeURIComponent(c.id)}`;
  return (
    <li className="cap-card">
      <div className="stack-xs">
        <div className="cap-card-head">
          <h2 className="cap-card-title">
            <a href={href}>{c.name}</a>
          </h2>
        </div>
        <div className="tag-row">
          <Tag data-size="sm" data-color={residency ? residencyColors[residency] : 'neutral'}>
            {c.location}
          </Tag>
          {c.used ? (
            <Tag data-size="sm" data-color="accent">
              {c.used}
            </Tag>
          ) : null}
        </div>
        <p className="cap-does">{c.does}</p>
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

export const SharedServices = ({ api, route, live }: ScreenProps) => {
  const t = useT();
  const [state, retry] = useAsync((signal) => api.sharedServices(signal), [api]);
  const [models] = useAsync((signal) => api.listModels({}, signal), [api]);
  const id = route.segments[1];
  if (state.status === 'loading' || models.status === 'loading')
    return <Loading label={t('sharedServices.loading')} />;
  if (state.status === 'error')
    return (
      <>
        <Heading level={1} data-size="lg">
          {t('sharedServices.title')}
        </Heading>
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  const entries = merge(t, state.data, models, live);

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
      <SharedServiceDetail api={api} capability={entry.capability} publicName={entry.publicName} />
    );
  }

  return (
    <div className="stack">
      <div className="page-head-text">
        <Heading level={1} data-size="lg">
          {t('sharedServices.title')}
        </Heading>
        <p className="lead">{t('sharedServices.lead')}</p>
      </div>
      {entries.length === 0 ? (
        <EmptyState title={t('sharedServices.emptyTitle')}>
          <Paragraph>{t('sharedServices.emptyBody')}</Paragraph>
        </EmptyState>
      ) : (
        <ul className="cap-grid">
          {entries.map((e) => (
            <Card key={e.capability.id} entry={e} />
          ))}
        </ul>
      )}
    </div>
  );
};
