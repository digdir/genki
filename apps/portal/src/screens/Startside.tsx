import {
  Alert,
  Button,
  Heading,
  List,
  Paragraph,
  SkipLink,
  Tag,
} from '@digdir/designsystemet-react';
import { useEffect, useState, type MouseEvent } from 'react';
import { Icon, icons } from '../components/Icon';
import { NotDecided } from '../components/NotDecided';
import { access, dataHandlingPath, logged, stored } from '../data/data-handling';
import {
  anchors,
  documentation,
  examples,
  gettingStarted,
  narrowAnchors,
  sharedCapabilities,
  terms,
  whatItDoes,
} from '../data/startside';
import { useT } from '../i18n';
import './startside.css';

const below = (px: number) => window.innerWidth < px;

const useBelow = (px: number) => {
  const [value, setValue] = useState(() => below(px));
  useEffect(() => {
    const update = () => setValue(below(px));
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [px]);
  return value;
};

const jumpTo = (id: string) => (event: MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault();
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
};

const Anchor = ({ id, label, onClick }: { id: string; label: string; onClick?: () => void }) => (
  <a
    href={`#${id}`}
    onClick={(event) => {
      jumpTo(id)(event);
      onClick?.();
    }}
  >
    {label}
  </a>
);

export const Startside = ({
  onLogin,
  busy,
  failed,
}: {
  onLogin: () => void;
  busy: boolean;
  failed: boolean;
}) => {
  const t = useT();
  const narrow = useBelow(1000);
  const tiny = useBelow(520);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);

  const dataCards: readonly (readonly [string, string, string?])[] = [
    [t('dataHandling.processingHeading'), t('dataHandling.processingToday')],
    [t('dataHandling.storedHeading'), stored.map((k) => t(k)).join(' ')],
    [t('dataHandling.loggedHeading'), logged.map((k) => t(k)).join(' ')],
    [
      t('dataHandling.storageTime'),
      t('dataHandling.storageTimeBody'),
      t('dataHandling.storageTimePlaceholder'),
    ],
    [t('dataHandling.accessWho'), access.map((k) => t(k)).join(' ')],
  ];

  return (
    <div className="startside">
      <SkipLink href="#hovedinnhold">{t('shell.skipToContent')}</SkipLink>
      <header className="start-header">
        <div className="start-header-bar">
          <a className="brand" href="#hovedinnhold" onClick={jumpTo('hovedinnhold')}>
            <img src="/emblem-felleslosning.svg" alt="" width={32} height={32} />
            <span className="brand-text">
              <span className="brand-owner">{t('shell.owner')}</span>
              <span className="brand-name">
                {tiny ? t('shell.brandShort') : t('shell.brandFull')}
              </span>
            </span>
          </a>
          <div className="header-spacer" />
          {narrow ? (
            <Button
              variant="tertiary"
              data-size="sm"
              aria-expanded={menuOpen}
              aria-controls="sidemeny"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <Icon d={icons.menu} />
              {t('shell.menu')}
            </Button>
          ) : (
            <nav aria-label={t('start.navOnPage')} className="start-anchors">
              {anchors.map(([id, label]) => (
                <Anchor key={id} id={id} label={t(label)} />
              ))}
            </nav>
          )}
          <Button variant="secondary" data-size="sm" onClick={onLogin} loading={busy}>
            {t('start.login')}
          </Button>
        </div>
        {narrow && menuOpen ? (
          <nav id="sidemeny" aria-label={t('start.navOnPage')} className="start-anchors-narrow">
            {narrowAnchors.map(([id, label]) => (
              <Anchor key={id} id={id} label={t(label)} onClick={() => setMenuOpen(false)} />
            ))}
          </nav>
        ) : null}
      </header>

      <main id="hovedinnhold" tabIndex={-1} className="start-main">
        {failed ? (
          <div className="start-wrap start-alert">
            <Alert data-color="danger" role="alert">
              {t('start.loginFailed')}
            </Alert>
          </div>
        ) : null}
        <div className="start-hero">
          <div className="start-wrap start-hero-grid">
            <div className="start-hero-text">
              <Heading level={1} data-size="xl" className="start-h1">
                {t('start.heroTitle')}
              </Heading>
              <p className="start-hero-lead">{t('start.heroLead')}</p>
              <div className="actions">
                <a
                  className="ds-button"
                  data-variant="primary"
                  href="#kom-i-gang"
                  onClick={jumpTo('kom-i-gang')}
                >
                  {t('start.navGetStarted')}
                </a>
                <a
                  className="ds-button"
                  data-variant="secondary"
                  href="#dokumentasjon"
                  onClick={jumpTo('dokumentasjon')}
                >
                  {t('start.readDocs')}
                </a>
              </div>
            </div>
            <dl className="start-facts">
              <div>
                <dt>{t('start.factWhoTitle')}</dt>
                <dd>{t('start.factWho')}</dd>
              </div>
              <div>
                <dt>{t('start.factWhereTitle')}</dt>
                <dd>{t('dataHandling.processingToday')}</dd>
              </div>
              <div>
                <dt>{t('start.factCostTitle')}</dt>
                <dd>
                  {t.rich('start.factCost', {
                    link: (label) => (
                      <a href="#pris" onClick={jumpTo('pris')}>
                        {label}
                      </a>
                    ),
                  })}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="start-wrap start-sections">
          <section id="hva" aria-labelledby="hva-h" className="start-section">
            <Heading level={2} data-size="lg" id="hva-h">
              {t('start.whatHeading')}
            </Heading>
            <div className="start-columns">
              {whatItDoes.map(([title, body]) => (
                <div key={title} className="stack-sm">
                  <h3 className="start-h3">{t(title)}</h3>
                  <p className="start-body">{t(body)}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="fellestjenester" aria-labelledby="felles-h" className="start-section">
            <div className="start-intro">
              <Heading level={2} data-size="lg" id="felles-h">
                {t('start.sharedHeading')}
              </Heading>
              <p className="start-sub">{t('start.sharedSub')}</p>
            </div>
            <ul className="plain-list start-cards">
              {sharedCapabilities.map(([title, body, example]) => (
                <li key={title} className="start-card">
                  <h3 className="start-h3">{t(title)}</h3>
                  <p className="start-card-body">{t(body)}</p>
                  <p className="start-card-meta">{t(example)}</p>
                </li>
              ))}
            </ul>
          </section>

          <section id="eksempler" aria-labelledby="eks-h" className="start-section">
            <div className="start-intro">
              <Heading level={2} data-size="lg" id="eks-h">
                {t('start.examplesHeading')}
              </Heading>
              <p className="start-sub">{t('start.examplesSub')}</p>
            </div>
            <div className="start-examples">
              {examples.map((ex) => (
                <article key={ex.title} className="start-example">
                  <div className="tag-row">
                    <Tag data-size="sm" data-color="accent">
                      {t(ex.job)}
                    </Tag>
                    <Tag data-size="sm" data-color="neutral">
                      {t(ex.trigger)}
                    </Tag>
                  </div>
                  <h3 className="start-h3 start-example-title">{t(ex.title)}</h3>
                  <p className="start-body">{t(ex.body)}</p>
                  <dl className="kv start-example-facts">
                    {ex.facts.map(([dt, dd]) => (
                      <div key={dt} className="kv-row">
                        <dt>{t(dt)}</dt>
                        <dd>{t(dd)}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
          </section>

          <section id="pris" aria-labelledby="pris-h" className="start-price">
            <div className="stack-sm">
              <Heading level={2} data-size="lg" id="pris-h">
                {t('start.priceHeading')}
              </Heading>
              <p className="start-lead">{t('start.priceLead')}</p>
              <div className="placeholder-box">
                <NotDecided />
                <span>{t('start.pricesNotDecided')}</span>
              </div>
              <Paragraph>{t('start.priceQuota')}</Paragraph>
            </div>
            <div className="stack-sm">
              <Heading level={2} data-size="lg">
                {t('start.termsHeading')} <NotDecided />
              </Heading>
              <List.Unordered className="start-terms">
                {terms.map((term) => (
                  <List.Item key={term}>{t(term)}</List.Item>
                ))}
              </List.Unordered>
              <div className="row-wrap start-links">
                <a href={dataHandlingPath}>{t('start.howDataLink')}</a>
              </div>
            </div>
          </section>

          <section id="data" aria-labelledby="data-h" className="start-section">
            <div className="start-intro">
              <Heading level={2} data-size="lg" id="data-h">
                {t('start.howDataLink')}
              </Heading>
              <Alert data-color="info" data-size="sm">
                {t('start.dataNotAdopted')}
              </Alert>
            </div>
            <div className="start-data">
              {dataCards.map(([title, body, placeholder]) => (
                <div key={title} className="start-card">
                  <h3 className="start-h3">{title}</h3>
                  <p className="start-body">{body}</p>
                  {placeholder ? (
                    <div className="placeholder-box">
                      <NotDecided />
                      <span>{placeholder}</span>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <a href={dataHandlingPath}>{t('start.dataReadMore')}</a>
          </section>

          <section id="kom-i-gang" aria-labelledby="kig-h" className="start-get-started">
            <div className="start-intro">
              <Heading level={2} data-size="lg" id="kig-h">
                {t('start.getStartedHeading')}
              </Heading>
              <p className="start-lead">{t('start.getStartedLead')}</p>
            </div>
            <ol className="plain-list start-steps">
              {gettingStarted.map(([title, body], i) => (
                <li key={title}>
                  <span aria-hidden="true" className="step-number">
                    {i + 1}
                  </span>
                  <h3 className="start-h3">{t(title)}</h3>
                  <p className="start-card-body">{t(body)}</p>
                </li>
              ))}
            </ol>
            <div className="row-wrap">
              <Button variant="primary" onClick={onLogin}>
                {t('start.sendRequest')}
              </Button>
            </div>
          </section>

          <section id="dokumentasjon" aria-labelledby="dok-h" className="start-section">
            <Heading level={2} data-size="lg" id="dok-h">
              {t('start.docsHeading')}
            </Heading>
            <ul className="plain-list start-docs">
              {documentation.map(([title, body]) => (
                <li key={title}>
                  <a href="#/docs" className="start-doc">
                    <span className="start-doc-title">{t(title)}</span>
                    <span className="start-doc-body">{t(body)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>

      <footer className="start-footer">
        <div className="start-wrap start-footer-bar">
          <span className="row-wrap">
            <img src="/emblem-felleslosning.svg" alt="" width={24} height={24} />
            {t('start.operatedBy')}
          </span>
          <nav aria-label={t('start.footer')} className="row-wrap">
            <a href="#/privacy">{t('start.privacy')}</a>
            <a href="#/accessibility">{t('start.accessibility')}</a>
            <a href="#/contact">{t('start.contact')}</a>
          </nav>
        </div>
      </footer>
    </div>
  );
};
