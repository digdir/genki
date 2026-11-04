import { Button, Card, Heading, Paragraph, Tag } from '@digdir/designsystemet-react';
import { links } from '@genai/docs-content';
import { ArchitectureDiagram, Figure, HeroStack, href } from '@genai/docs-site';
import { useLocale } from '@genai/i18n/react';
import { ArrowRightIcon } from '@navikt/aksel-icons';
import type { CSSProperties, ReactNode } from 'react';
import { dataHandlingPath } from '../../data/data-handling';
import { examples, gettingStarted, sharedCapabilities } from '../../data/startside';
import { useT } from '../../i18n';
import { jumpTo, useBelow } from '../Startside';
import { pricePath, useDocumentTitle } from './public-pages';

const Section = ({
  id,
  heading,
  lede,
  children,
}: {
  id: string;
  heading: string;
  lede?: ReactNode;
  children: ReactNode;
}) => (
  <section id={id} className="about-section" aria-labelledby={`${id}-h`}>
    <div className="about-section-head">
      <Heading level={2} data-size="sm" id={`${id}-h`}>
        {heading}
      </Heading>
      {lede ? <p className="about-section-lede">{lede}</p> : null}
    </div>
    {children}
  </section>
);

const Hero = ({ onRequest }: { onRequest: string }) => {
  const t = useT();
  const { locale } = useLocale();
  const phone = useBelow(600);
  return (
    <section className="about-hero" aria-labelledby="about-h1">
      <div className="about-hero-text">
        <Heading level={1} data-size="xl" id="about-h1" className="about-h1">
          {t('about.heroTitle')}
        </Heading>
        <p className="about-hero-lede">{t('about.heroLede')}</p>
        <div className="about-actions">
          <Button variant="primary" asChild>
            <a href={`#${onRequest}`} onClick={jumpTo(onRequest)}>
              {t('about.requestAccess')}
            </a>
          </Button>
          <Button variant="secondary" asChild>
            <a href={href({ page: 'byggeklosser' })}>
              {t('about.exploreBlocks')} <ArrowRightIcon aria-hidden />
            </a>
          </Button>
        </div>
        {locale === 'nb' ? null : <p className="about-note">{t('about.nbOnly')}</p>}
      </div>
      <Figure
        className="hero-visual about-hero-figure"
        label={t('about.layersLabel')}
        keyboardNav="focus"
      >
        <HeroStack compact={phone} />
      </Figure>
    </section>
  );
};

const Facts = () => {
  const t = useT();
  const facts = [
    [t('about.factWhoTitle'), t('about.factWho')],
    [t('about.factWhereTitle'), t('dataHandling.processingToday')],
    [t('about.factCostTitle'), t('about.factCost')],
  ] as const;
  return (
    <Card data-color="neutral" className="about-card about-facts">
      <dl aria-label={t('about.factsLabel')} data-count={facts.length}>
        {facts.map(([title, body]) => (
          <div key={title}>
            <dt>{title}</dt>
            <dd>{body}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
};

const Build = () => {
  const t = useT();
  return (
    <Section id="lage" heading={t('about.buildHeading')} lede={t('about.buildLede')}>
      <div className="about-sub">
        <Heading level={3} data-size="xs">
          {t('about.sharedHeading')}
        </Heading>
        <Paragraph data-size="sm" className="about-muted">
          {t('start.sharedSub')}
        </Paragraph>
        <ul
          className="about-grid about-plain about-rows"
          data-count={sharedCapabilities.length}
          style={{ '--rows': 3 } as CSSProperties}
        >
          {sharedCapabilities.map(([title, body, example]) => (
            <li key={title} className="about-card about-item">
              <Heading level={4} data-size="xs">
                {t(title)}
              </Heading>
              <Paragraph data-size="sm">{t(body)}</Paragraph>
              <Paragraph data-size="xs" className="about-muted">
                {t(example)}
              </Paragraph>
            </li>
          ))}
        </ul>
      </div>
      <div className="about-sub">
        <Heading level={3} data-size="xs">
          {t('about.examplesHeading')}
        </Heading>
        <Paragraph data-size="sm" className="about-muted">
          {t('start.examplesSub')}
        </Paragraph>
        <ul
          className="about-grid about-plain about-rows"
          data-count={examples.length}
          style={{ '--rows': 4 } as CSSProperties}
        >
          {examples.map((ex) => (
            <li key={ex.title} className="about-card about-item about-example">
              <div className="about-tags">
                <Tag data-size="sm" data-color="neutral">
                  {t(ex.job)}
                </Tag>
              </div>
              <Heading level={4} data-size="xs">
                {t(ex.title)}
              </Heading>
              <Paragraph data-size="sm">{t(ex.body)}</Paragraph>
              <dl className="kv">
                {[['start.exTrigger', ex.trigger] as const, ...ex.facts].map(([dt, dd]) => (
                  <div key={dt} className="kv-row">
                    <dt>{t(dt)}</dt>
                    <dd>{t(dd)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
};

const Architecture = () => {
  const t = useT();
  return (
    <Section
      id="arkitektur"
      heading={t('about.architectureHeading')}
      lede={t('about.architectureSub')}
    >
      <Figure
        className="diagram-wrap about-diagram"
        label={t('about.architectureFigure')}
        keyboardNav="figure"
      >
        <ArchitectureDiagram />
      </Figure>
    </Section>
  );
};

const More = () => {
  const t = useT();
  const tiles = [
    [pricePath, t('about.tilePriceTitle'), t('about.tilePriceBody')],
    [dataHandlingPath, t('about.tileDataTitle'), t('about.tileDataBody')],
    [href({ page: 'status' }), t('about.tileStatusTitle'), t('about.tileStatusBody')],
  ] as const;
  return (
    <Section id="pris-og-data" heading={t('about.moreHeading')} lede={t('about.notice')}>
      <ul className="about-grid about-plain about-tiles" data-count={tiles.length}>
        {tiles.map(([to, title, body]) => (
          <li key={to}>
            <Card data-color="neutral" asChild className="about-card about-tile">
              <a href={to}>
                <Heading level={3} data-size="xs">
                  {title}
                </Heading>
                <Paragraph data-size="sm">{body}</Paragraph>
              </a>
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  );
};

const Access = ({ id, onLogin }: { id: string; onLogin: () => void }) => {
  const t = useT();
  return (
    <Section id={id} heading={t('about.accessHeading')}>
      <ol
        className="about-grid about-plain about-rows about-steps"
        data-count={gettingStarted.length}
        style={{ '--rows': 2 } as CSSProperties}
      >
        {gettingStarted.map(([title, body], i) => (
          <li key={title} className="about-card about-step">
            <div className="about-step-head">
              <span className="about-step-number" aria-hidden="true">
                {i + 1}
              </span>
              <Heading level={3} data-size="xs">
                {t(title)}
              </Heading>
            </div>
            <Paragraph data-size="sm">{t(body)}</Paragraph>
          </li>
        ))}
      </ol>
      <div className="about-access-actions">
        <Button variant="primary" onClick={onLogin}>
          {t('about.requestAccess')}
        </Button>
        <Paragraph data-size="sm">
          {t.rich('about.haveAccess', {
            login: (label) => (
              <button type="button" className="about-link-button" onClick={onLogin}>
                {label}
              </button>
            ),
          })}
        </Paragraph>
      </div>
    </Section>
  );
};

const Together = () => {
  const t = useT();
  return (
    <section className="about-band" aria-labelledby="sammen-h">
      <div className="about-band-text">
        <Heading level={2} data-size="sm" id="sammen-h">
          {t('about.togetherHeading')}
        </Heading>
        <Paragraph data-size="sm">{t('about.togetherBody')}</Paragraph>
      </div>
      <div className="about-band-links">
        <a href={links.repo}>{t('about.sourceLink')}</a>
        <a href={links.adr}>{t('about.adrLink')}</a>
      </div>
    </section>
  );
};

export const PublicStart = ({ onLogin }: { onLogin: () => void }) => {
  const t = useT();
  useDocumentTitle(t('about.heroTitle'), true);
  const accessId = 'kom-i-gang';
  return (
    <div className="about-start">
      <div className="about-hero-block">
        <Hero onRequest={accessId} />
        <Facts />
      </div>
      <Build />
      <Architecture />
      <More />
      <Access id={accessId} onLogin={onLogin} />
      <Together />
    </div>
  );
};
