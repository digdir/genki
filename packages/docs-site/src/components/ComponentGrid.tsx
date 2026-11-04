import { Card, Heading, Paragraph } from '@digdir/designsystemet-react';
import { ArrowRightIcon } from '@navikt/aksel-icons';
import type { Component } from '@genai/docs-content';
import { StatusTag } from './StatusTag';
import { href } from '../router';
import { useContentLang } from '../document';
import { useT } from '../i18n';

/** Byggeklossene under en overordnet byggekloss: ett kort per byggekloss, klikkbart til egen side. */
export function ComponentGrid({
  blockId,
  components,
}: {
  blockId: string;
  components: Component[];
}) {
  const t = useT();
  const lang = useContentLang();
  return (
    <ol className="component-grid" aria-label={t('docsCommon.blocks')}>
      {components.map((c) => (
        <li key={c.id}>
          <Card className="component-card">
            <Card.Block>
              <div className="component-head">
                <div className="stack" style={{ gap: 'var(--ds-size-1)' }} lang={lang}>
                  <Heading level={3} data-size="2xs" style={{ margin: 0 }}>
                    <a
                      className="component-link"
                      href={href({
                        page: 'byggeklosser',
                        id: blockId,
                        sub: c.id,
                      })}
                    >
                      {c.name}
                    </a>
                  </Heading>
                  <Paragraph
                    data-size="xs"
                    style={{
                      margin: 0,
                      color: 'var(--ds-color-neutral-text-subtle)',
                    }}
                  >
                    {c.tagline}
                  </Paragraph>
                </div>
              </div>
            </Card.Block>
            <Card.Block>
              <div className="component-foot">
                <StatusTag status={c.status} />
                <a
                  className="case-cta"
                  href={href({ page: 'byggeklosser', id: blockId, sub: c.id })}
                >
                  {t('docsBlocks.capabilityCount', { count: c.capabilities.length })}{' '}
                  <ArrowRightIcon aria-hidden />
                </a>
              </div>
            </Card.Block>
          </Card>
        </li>
      ))}
    </ol>
  );
}
