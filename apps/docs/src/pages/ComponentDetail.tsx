import { Alert, Button, Card, Heading, Link, Paragraph } from '@digdir/designsystemet-react';
import { ChevronLeftIcon, ChevronRightIcon } from '@navikt/aksel-icons';
import { ArchitectureDiagram, nodeForBlock, toneForBlock } from '../components/ArchitectureDiagram';
import { Figure } from '../components/Figure';
import { LiveModels, liveByPart } from '../components/HuggingFaceLive';
import { BlockIcon } from '../components/icons';
import { blockById } from '../data/blocks';
import { componentById, componentsFor } from '../data/components';
import { usePagerKeys } from '../components/usePagerKeys';
import { href } from '../router';

/** Én byggekloss under en overordnet byggekloss, med egenskaper, typiske valg og anbefalt praksis. */
export function ComponentDetail({ blockId, id }: { blockId: string; id: string }) {
  const block = blockById(blockId);
  const comp = block ? componentById(blockId, id) : undefined;
  if (!block || !comp) {
    return (
      <div className="stack">
        <Alert data-color="warning">
          Fant ingen byggekloss med id «{id}» under «{blockId}».
        </Alert>
        <Link href={href({ page: 'byggeklosser', id: blockId })}>
          Til den overordnede byggeklossen
        </Link>
      </div>
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
        <nav className="crumbs" aria-label="Du er her">
          <Link href={href({ page: 'byggeklosser' })}>Byggeklosser</Link>
          <span aria-hidden>/</span>
          <Link href={href({ page: 'byggeklosser', id: block.id })}>{block.name}</Link>
          <span aria-hidden>/</span>
          <span>{comp.name}</span>
        </nav>
        <div className="detail-head">
          <span className="detail-icon">
            <BlockIcon id={block.id} />
          </span>
          <div className="stack" style={{ gap: 'var(--ds-size-2)' }}>
            <Heading level={1} data-size="lg" style={{ margin: 0 }}>
              {comp.name}
            </Heading>
            <Paragraph className="lede" style={{ margin: 0 }}>
              {comp.tagline}
            </Paragraph>
          </div>
        </div>
      </div>

      <Figure
        className="diagram-wrap"
        label="Målarkitekturen"
        fit
        keyboardNav="figure"
        hint="Piltastene flytter markeringen, Enter åpner. Esc lukker."
      >
        <ArchitectureDiagram
          highlight={block.id === 'ki-infrastruktur' ? `infra:${comp.id}` : nodeForBlock[block.id]}
          compact
        />
      </Figure>

      <div className="detail-grid">
        <div className="stack">
          <Paragraph style={{ margin: 0 }}>{comp.description}</Paragraph>
          <Heading level={2} data-size="xs" style={{ margin: 0 }}>
            Egenskaper
          </Heading>
          <ul className="cap-list">
            {comp.capabilities.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <div className="stack">
          {comp.options && (
            <Card className="reuse-box">
              <Card.Block>
                <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                  Typiske valg
                </Heading>
              </Card.Block>
              <Card.Block>
                <ul className="cap-list compact">
                  {comp.options.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              </Card.Block>
            </Card>
          )}
          {comp.practices && (
            <Card className="reuse-box">
              <Card.Block>
                <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                  Anbefalt praksis
                </Heading>
              </Card.Block>
              <Card.Block>
                <ul className="cap-list compact">
                  {comp.practices.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
              </Card.Block>
            </Card>
          )}
        </div>
      </div>

      {block.id === 'sprakmodeller' && liveByPart[comp.id] && (
        <LiveModels lists={liveByPart[comp.id]} />
      )}

      <div className="pager" title="Piltast venstre og høyre bytter side">
        <Button variant="secondary" asChild>
          <a href={href({ page: 'byggeklosser', id: block.id, sub: prev.id })}>
            <ChevronLeftIcon aria-hidden /> {prev.name}
          </a>
        </Button>
        <Button variant="secondary" asChild>
          <a href={href({ page: 'byggeklosser', id: block.id, sub: next.id })}>
            {next.name} <ChevronRightIcon aria-hidden />
          </a>
        </Button>
      </div>
    </div>
  );
}
