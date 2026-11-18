import { Card, Heading, Paragraph } from '@digdir/designsystemet-react';
import { type Block, componentsFor } from '@genai/docs-content';
import { StatusTag } from './StatusTag';
import { href, navigate } from '../router';
import { toneForBlock } from './ArchitectureDiagram';
import { BlockIcon } from './icons';
import { useContentLang } from '../document';
import { useT } from '../i18n';

export function BlockCard({ block }: { block: Block }) {
  const t = useT();
  const lang = useContentLang();
  const open = () => navigate({ page: 'byggeklosser', id: block.id });
  return (
    <div style={{ height: '100%' }}>
      <Card
        data-tone={toneForBlock[block.id]}
        className="block-card fig"
        role="link"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
        aria-label={`${block.name}: ${block.tagline}`}
      >
        <Card.Block>
          <div className="block-card-head">
            <span className="block-icon toned">
              <BlockIcon id={block.id} />
            </span>
            <div>
              <Heading level={3} data-size="xs" style={{ margin: 0 }} lang={lang}>
                {block.name}
              </Heading>
            </div>
          </div>
        </Card.Block>
        <Card.Block>
          <Paragraph data-size="sm" style={{ margin: 0 }} lang={lang}>
            {block.tagline}
          </Paragraph>
        </Card.Block>
        <Card.Block>
          <div className="cluster" style={{ justifyContent: 'space-between' }}>
            <StatusTag status={block.status} />
            <a
              href={href({ page: 'byggeklosser', id: block.id })}
              onClick={(e) => e.stopPropagation()}
              style={{ fontSize: 'var(--ds-font-size-2)' }}
            >
              {t('docsBlocks.componentCount', { count: componentsFor(block.id).length })}
            </a>
          </div>
        </Card.Block>
      </Card>
    </div>
  );
}
