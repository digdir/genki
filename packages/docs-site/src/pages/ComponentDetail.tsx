import { Button, Card, Heading, Paragraph } from '@digdir/designsystemet-react';
import { ChevronLeftIcon, ChevronRightIcon } from '@navikt/aksel-icons';
import { ArchitectureDiagram, nodeForBlock, toneForBlock } from '../components/ArchitectureDiagram';
import { Figure } from '../components/Figure';
import { LiveModels, liveByPart } from '../components/HuggingFaceLive';
import { BlockIcon } from '../components/icons';
import { blockById, componentById, componentsFor } from '@genai/docs-content';
import { BackLink } from '../components/BackLink';
import { NotFound } from '../components/NotFound';
import { usePagerKeys } from '../components/usePagerKeys';
import { href, routingOptions } from '../router';
import { useContentLang, useDocumentTitle } from '../document';
import { useT } from '../i18n';

/** Én byggekloss under en overordnet byggekloss, med egenskaper, typiske valg og anbefalt praksis. */
export function ComponentDetail({ blockId, id }: { blockId: string; id: string }) {
  const t = useT();
  const lang = useContentLang();
  const block = blockById(blockId);
  const comp = block ? componentById(blockId, id) : undefined;
  useDocumentTitle(comp?.name ?? t('docsBlocks.notFoundTitle'));
  if (!block || !comp) {
    return (
      <NotFound
        title={t('docsBlocks.notFoundTitle')}
        message={t('docsBlocks.partNotFound', { id, block: blockId })}
        back={
          block
            ? { href: href({ page: 'byggeklosser', id: blockId }), label: t('docsBlocks.toBlock') }
            : { href: href({ page: 'byggeklosser' }), label: t('docsBlocks.toAll') }
        }
      />
    );
  }
  const siblings = componentsFor(blockId);
  const idx = siblings.indexOf(comp);
  const prev = siblings[(idx - 1 + siblings.length) % siblings.length];
  const next = siblings[(idx + 1) % siblings.length];
  usePagerKeys(
    { page: 'byggeklosser', id: block.id, sub: prev.id },
    { page: 'byggeklosser', id: block.id, sub: next.id },
  );

  return (
    <div className="stack-lg fig" data-tone={toneForBlock[block.id]}>
      <div className="stack">
        <BackLink href={href({ page: 'byggeklosser', id: block.id })} lang={lang}>
          {block.name}
        </BackLink>
        <div className="detail-head">
          <span className="detail-icon">
            <BlockIcon id={block.id} />
          </span>
          <div className="stack" style={{ gap: 'var(--ds-size-2)' }}>
            <Heading level={1} data-size="lg" style={{ margin: 0 }} lang={lang}>
              {comp.name}
            </Heading>
            <Paragraph className="lede" style={{ margin: 0 }} lang={lang}>
              {comp.tagline}
            </Paragraph>
          </div>
        </div>
      </div>

      <Figure
        className="diagram-wrap"
        label={t('docsFigure.architecture')}
        fit
        keyboardNav="figure"
        hint={t('docsFigure.hintArrows')}
      >
        <ArchitectureDiagram
          highlight={block.id === 'ki-infrastruktur' ? `infra:${comp.id}` : nodeForBlock[block.id]}
          compact
        />
      </Figure>

      <div className="detail-grid">
        <div className="stack">
          <Paragraph style={{ margin: 0 }} lang={lang}>
            {comp.description}
          </Paragraph>
          <Heading level={2} data-size="sm" style={{ margin: 0 }}>
            {t('docsBlocks.capabilities')}
          </Heading>
          <ul className="cap-list">
            {comp.capabilities.map((c) => (
              <li key={c} lang={lang}>
                {c}
              </li>
            ))}
          </ul>
        </div>
        <div className="stack">
          {comp.options && (
            <Card className="reuse-box">
              <Card.Block>
                <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                  {t('docsBlocks.options')}
                </Heading>
              </Card.Block>
              <Card.Block>
                <ul className="cap-list compact">
                  {comp.options.map((o) => (
                    <li key={o} lang={lang}>
                      {o}
                    </li>
                  ))}
                </ul>
              </Card.Block>
            </Card>
          )}
          {comp.practices && (
            <Card className="reuse-box">
              <Card.Block>
                <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                  {t('docsBlocks.practices')}
                </Heading>
              </Card.Block>
              <Card.Block>
                <ul className="cap-list compact">
                  {comp.practices.map((o) => (
                    <li key={o} lang={lang}>
                      {o}
                    </li>
                  ))}
                </ul>
              </Card.Block>
            </Card>
          )}
        </div>
      </div>

      {routingOptions().liveModels && block.id === 'sprakmodeller' && liveByPart[comp.id] && (
        <LiveModels lists={liveByPart[comp.id]} />
      )}

      <div className="pager" title={t('docsCommon.pagerTitle')}>
        <Button variant="secondary" asChild>
          <a href={href({ page: 'byggeklosser', id: block.id, sub: prev.id })} lang={lang}>
            <ChevronLeftIcon aria-hidden /> {prev.name}
          </a>
        </Button>
        <Button variant="secondary" asChild>
          <a href={href({ page: 'byggeklosser', id: block.id, sub: next.id })} lang={lang}>
            {next.name} <ChevronRightIcon aria-hidden />
          </a>
        </Button>
      </div>
    </div>
  );
}
