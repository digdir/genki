import { Button, Card, Heading, Paragraph } from '@digdir/designsystemet-react';
import type { ReactNode } from 'react';
import { ArrowRightIcon } from '@navikt/aksel-icons';
import { ArchitectureDiagram } from '../components/ArchitectureDiagram';
import { Figure } from '../components/Figure';
import { HeroStack } from '../components/HeroStack';
import { links } from '@genai/docs-content';
import { href } from '../router';
import { useDocumentTitle } from '../document';
import { useT } from '../i18n';

export function Overview({ children }: { children?: ReactNode }) {
  const t = useT();
  useDocumentTitle('');
  return (
    <div className="stack-lg">
      <section className="hero">
        <div className="stack">
          <div>
            <Heading level={1} data-size="xl" style={{ margin: 0 }}>
              {t('docsOverview.title')}
            </Heading>
          </div>
          <p className="lede">{t('docsOverview.lede')}</p>
          <div className="cluster">
            <Button asChild>
              <a href={href({ page: 'byggeklosser' })}>
                {t('docsOverview.explore')} <ArrowRightIcon aria-hidden />
              </a>
            </Button>
            <Button variant="secondary" asChild>
              <a href={href({ page: 'tjenester' })}>{t('docsOverview.seeFlow')}</a>
            </Button>
            <Button variant="tertiary" asChild>
              <a href={links.repo}>{t('docsOverview.source')}</a>
            </Button>
          </div>
        </div>
        <Figure
          className="hero-visual"
          label={t('docsFigure.layers')}
          keyboardNav="focus"
          hint={t('docsFigure.hintArrows')}
        >
          <HeroStack />
        </Figure>
      </section>

      <section className="stack">
        <div className="section-head">
          <div>
            <p className="fig-caption">{t('docsOverview.caption')}</p>
            <Heading level={2} data-size="md" style={{ margin: 0 }}>
              {t('docsOverview.architecture')}
            </Heading>
            <Paragraph
              data-size="sm"
              style={{
                margin: 0,
                color: 'var(--ds-color-neutral-text-subtle)',
              }}
            >
              {t('docsOverview.architectureSub')}
            </Paragraph>
          </div>
        </div>
        <Figure
          className="diagram-wrap"
          label={t('docsFigure.architecture')}
          keyboardNav="figure"
          hint={t('docsFigure.hintArrows')}
        >
          <ArchitectureDiagram />
        </Figure>
      </section>

      <section className="stack together">
        <div>
          <p className="fig-caption">{t('docsOverview.togetherCaption')}</p>
          <Heading level={2} data-size="md" style={{ margin: 0 }}>
            {t('docsOverview.together')}
          </Heading>
        </div>
        <Paragraph className="lede" style={{ margin: 0 }}>
          {t('docsOverview.togetherLede')}
        </Paragraph>
        <div className="grid">
          {[
            {
              t: t('docsOverview.openTitle'),
              d: t('docsOverview.openBody'),
              href: links.repo,
              cta: t('docsOverview.openLink'),
            },
            {
              t: t('docsOverview.acrossTitle'),
              d: t('docsOverview.acrossBody'),
              href: href({ page: 'kom-i-gang' }),
              cta: t('docsOverview.acrossLink'),
            },
            {
              t: t('docsOverview.contributeTitle'),
              d: t('docsOverview.contributeBody'),
              href: links.adr,
              cta: t('docsOverview.contributeLink'),
            },
          ].map((c) => (
            <div key={c.t}>
              <Card data-color="neutral" className="together-card" style={{ height: '100%' }}>
                <Card.Block>
                  <Heading level={3} data-size="xs" style={{ margin: 0 }}>
                    {c.t}
                  </Heading>
                </Card.Block>
                <Card.Block>
                  <Paragraph data-size="sm" style={{ margin: 0 }}>
                    {c.d}
                  </Paragraph>
                </Card.Block>
                <Card.Block>
                  <a href={c.href}>{c.cta}</a>
                </Card.Block>
              </Card>
            </div>
          ))}
        </div>
      </section>
      {children}
    </div>
  );
}
