import { Button, Card, Heading, Link, Paragraph } from '@digdir/designsystemet-react';
import { ChevronLeftIcon, ChevronRightIcon } from '@navikt/aksel-icons';
import { BlockIcon, TypeIcon } from '../components/icons';
import { blockById, caseById, serviceTypeById, serviceTypes } from '@genai/docs-content';
import { BackLink } from '../components/BackLink';
import { NotFound } from '../components/NotFound';
import { usePagerKeys } from '../components/usePagerKeys';
import { useContentLang, useDocumentTitle } from '../document';
import { useT } from '../i18n';
import { href } from '../router';

/** Én type KI-tjeneste: hva den er, når den passer, hvordan den bygges på Genki, og eksempler. */
export function ServiceTypeDetail({ id }: { id: string }) {
  const t = useT();
  const lang = useContentLang();
  const type = serviceTypeById(id);
  useDocumentTitle(type?.name ?? t('docsTypes.notFoundTitle'));
  if (!type) {
    return (
      <NotFound
        title={t('docsTypes.notFoundTitle')}
        message={t('docsTypes.notFound', { id })}
        back={{ href: href({ page: 'typer' }), label: t('docsTypes.toAll') }}
      />
    );
  }
  const idx = serviceTypes.indexOf(type);
  const prev = serviceTypes[(idx - 1 + serviceTypes.length) % serviceTypes.length];
  const next = serviceTypes[(idx + 1) % serviceTypes.length];
  usePagerKeys({ page: 'typer', id: prev.id }, { page: 'typer', id: next.id });
  const flows = type.cases.map((c) => caseById(c)).filter((c) => c !== undefined);

  return (
    <div className="stack-lg">
      <div className="stack">
        <BackLink href={href({ page: 'typer' })}>{t('docsTypes.all')}</BackLink>
        <div className="detail-head">
          <span className="detail-icon type-icon">
            <TypeIcon id={type.id} />
          </span>
          <div className="stack" style={{ gap: 'var(--ds-size-2)' }}>
            <Paragraph
              data-size="xs"
              style={{
                margin: 0,
                color: 'var(--ds-color-neutral-text-subtle)',
              }}
            >
              {t('docsTypes.kicker')}
            </Paragraph>
            <Heading level={1} data-size="lg" style={{ margin: 0 }} lang={lang}>
              {type.name}
            </Heading>
            <Paragraph className="lede" style={{ margin: 0 }} lang={lang}>
              {type.tagline}
            </Paragraph>
          </div>
        </div>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <Paragraph style={{ margin: 0 }} lang={lang}>
            {type.intro}
          </Paragraph>
          <div className="prose">
            {type.description.map((p, i) => (
              <Paragraph key={i} lang={lang}>
                {p}
              </Paragraph>
            ))}
          </div>

          <Heading level={2} data-size="sm" style={{ margin: 0 }}>
            {t('docsTypes.build')}
          </Heading>
          <ol className="build-list">
            {type.build.map((b) => {
              const block = b.block ? blockById(b.block) : undefined;
              return (
                <li key={b.label} lang={lang}>
                  <span className="build-label">{b.label}</span>
                  <span className="build-text">
                    {b.text}
                    {block && (
                      <>
                        {' '}
                        <Link href={href({ page: 'byggeklosser', id: block.id })} data-size="sm">
                          <BlockIcon id={block.id} className="inline-icon" />
                          <span>{block.name}</span>
                        </Link>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="stack">
          <Card className="reuse-box">
            <Card.Block>
              <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                {t('docsTypes.fits')}
              </Heading>
            </Card.Block>
            <Card.Block>
              <ul className="cap-list compact">
                {type.fits.map((f) => (
                  <li key={f} lang={lang}>
                    {f}
                  </li>
                ))}
              </ul>
            </Card.Block>
          </Card>
          <Card className="reuse-box">
            <Card.Block>
              <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                {t('docsTypes.avoid')}
              </Heading>
            </Card.Block>
            <Card.Block>
              <ul className="cap-list compact">
                {type.avoid.map((f) => (
                  <li key={f} lang={lang}>
                    {f}
                  </li>
                ))}
              </ul>
            </Card.Block>
          </Card>
          <Card className="reuse-box">
            <Card.Block>
              <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                {t('docsTypes.examples')}
              </Heading>
            </Card.Block>
            <Card.Block>
              <ul className="cap-list compact">
                {type.examples.map((f) => (
                  <li key={f} lang={lang}>
                    {f}
                  </li>
                ))}
              </ul>
            </Card.Block>
          </Card>
        </div>
      </div>

      {flows.length > 0 && (
        <section className="stack">
          <div>
            <p className="fig-caption">{t('docsTypes.stepByStep')}</p>
            <Heading level={2} data-size="sm" style={{ margin: 0 }}>
              {t('docsTypes.flowsFor', { name: type.name.toLowerCase() })}
            </Heading>
          </div>
          <div className="grid">
            {flows.map((c) => (
              <Card key={c.id} className="case-card" style={{ height: '100%' }} lang={lang}>
                <Card.Block>
                  <div
                    className="cluster"
                    style={{
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Heading level={3} data-size="xs" style={{ margin: 0 }}>
                      <Link href={href({ page: 'tjenester', id: c.id })}>{c.name}</Link>
                    </Heading>
                  </div>
                </Card.Block>
              </Card>
            ))}
          </div>
        </section>
      )}

      <div className="pager" title={t('docsCommon.pagerTitle')}>
        <Button variant="secondary" asChild>
          <a href={href({ page: 'typer', id: prev.id })} lang={lang}>
            <ChevronLeftIcon aria-hidden /> {prev.name}
          </a>
        </Button>
        <Button variant="secondary" asChild>
          <a href={href({ page: 'typer', id: next.id })} lang={lang}>
            {next.name} <ChevronRightIcon aria-hidden />
          </a>
        </Button>
      </div>
    </div>
  );
}
