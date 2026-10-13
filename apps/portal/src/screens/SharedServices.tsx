import { Button, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { findCapability, type SharedCapability } from '../data/shared-services';
import { useAsync } from '../hooks';
import { modelLabel } from '../models';
import { useT, type T } from '../i18n';
import type { ScreenProps } from '../screen';
import { EmptyState, ErrorState, Loading } from '../states';
import type { SharedService } from '../types';
import { SharedServiceDetail } from './shared/SharedServiceDetail';
import './shared.css';

interface Entry {
  capability: SharedCapability;
  publicName: string;
}

const residencyLabel = (t: T, r: string | null) =>
  r === 'norway'
    ? t('sharedServices.residencyNorway')
    : r === 'eu'
      ? t('sharedServices.residencyEu')
      : r
        ? t('sharedServices.residencyOutside')
        : t('sharedServices.notGiven');

const fromApi = (t: T, s: SharedService): SharedCapability => ({
  id: s.id,
  alias: s.id,
  tool: `digdir.${s.id}`,
  name: s.name,
  version: s.version === null ? '–' : String(s.version),
  does: s.purpose,
  long: s.purpose,
  input: t('sharedServices.text'),
  output: t('sharedServices.text'),
  model: s.model ? modelLabel(s.model) : t('sharedServices.notGiven'),
  location: residencyLabel(t, s.residency),
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

const merge = (t: T, services: SharedService[], live: boolean): Entry[] =>
  services.map((s) => {
    const design = live ? undefined : findCapability(s.id);
    return {
      capability: design ?? fromApi(t, s),
      publicName: s.variants[0]?.publicName ?? `${s.id}__default`,
    };
  });

const Card = ({ entry: { capability: c } }: { entry: Entry }) => {
  const t = useT();
  const href = `#/shared-services/${encodeURIComponent(c.id)}`;
  return (
    <li className="cap-card">
      <div className="stack-xs">
        <div className="cap-card-head">
          <h2 className="cap-card-title">
            <a href={href}>{c.name}</a>
          </h2>
          {c.used ? (
            <Tag data-size="sm" data-color="accent">
              {c.used}
            </Tag>
          ) : null}
        </div>
        <p className="cap-does">{c.does}</p>
      </div>
      <dl className="kv">
        <dt>{t('sharedServices.input')}</dt>
        <dd>{c.input}</dd>
        <dt>{t('sharedServices.output')}</dt>
        <dd>{c.output}</dd>
        <dt>{t('sharedServices.model')}</dt>
        <dd className="tag-row">
          {c.model}
          <Tag
            data-size="sm"
            data-color={
              c.location === 'Norge' || c.location === t('sharedServices.residencyNorway')
                ? 'success'
                : c.location === 'EU/EØS' || c.location === t('sharedServices.residencyEu')
                  ? 'info'
                  : 'warning'
            }
          >
            {c.location}
          </Tag>
        </dd>
      </dl>
      <div className="cap-figures">
        <div>
          <span className="meta">{t('sharedServices.quality')}</span>
          <span className="cap-figure">
            {c.score
              ? t('sharedServices.scoreOf', { score: c.score })
              : t('sharedServices.notMeasured')}
          </span>
          {c.scoreNote ? <span className="score-note">{c.scoreNote}</span> : null}
        </div>
        <div>
          <span className="meta">{t('sharedServices.per1000')}</span>
          <span className="cap-figure">{c.price}</span>
          <span className="meta">{c.priceNote}</span>
        </div>
      </div>
      <Button
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
  const id = route.segments[1];
  if (state.status === 'loading') return <Loading label={t('sharedServices.loading')} />;
  if (state.status === 'error')
    return (
      <>
        <Heading level={1} data-size="lg">
          {t('sharedServices.title')}
        </Heading>
        <ErrorState error={state.error} onRetry={retry} />
      </>
    );
  const entries = merge(t, state.data, live);

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
      <p className="meta footnote">{t('sharedServices.footnote')}</p>
    </div>
  );
};
