import {
  Alert,
  Button,
  Card,
  Heading,
  Link,
  Paragraph,
  Table,
  Tabs,
} from '@digdir/designsystemet-react';
import { ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from '@navikt/aksel-icons';
import { ArchitectureDiagram, nodeForBlock, toneForBlock } from '../components/ArchitectureDiagram';
import { Figure } from '../components/Figure';
import { BlockIcon } from '../components/icons';
import { ADR_BASE, blockById, blocks, models } from '../data/blocks';
import { componentsFor } from '../data/components';
import { ComponentGrid } from '../components/ComponentGrid';
import { StatusTag } from '../components/StatusTag';
import { usePagerKeys } from '../components/usePagerKeys';
import { href } from '../router';

export function BlockDetail({ id }: { id: string }) {
  const block = blockById(id);
  if (!block) {
    return (
      <div className="stack">
        <Alert data-color="warning">Fant ingen overordnet byggekloss med id «{id}».</Alert>
        <Link href={href({ page: 'byggeklosser' })}>Til alle byggeklossene</Link>
      </div>
    );
  }
  const components = componentsFor(block.id);
  // Forrige/neste følger figurens rekkefølge, ikke den alfabetiske listen.
  const idx = blocks.indexOf(block);
  const prev = blocks[(idx - 1 + blocks.length) % blocks.length];
  const next = blocks[(idx + 1) % blocks.length];
  usePagerKeys({ page: 'byggeklosser', id: prev.id }, { page: 'byggeklosser', id: next.id });

  return (
    <div className="stack-lg fig" data-tone={toneForBlock[block.id]}>
      <div className="stack">
        <Link href={href({ page: 'byggeklosser' })}>
          <ChevronLeftIcon aria-hidden /> Alle byggeklosser
        </Link>
        <div className="detail-head">
          <span className="detail-icon">
            <BlockIcon id={block.id} />
          </span>
          <div className="stack" style={{ gap: 'var(--ds-size-2)' }}>
            <Heading level={1} data-size="lg" style={{ margin: 0 }}>
              {block.name}
            </Heading>
            <Paragraph className="lede" style={{ margin: 0 }}>
              {block.tagline}
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
        <ArchitectureDiagram highlight={nodeForBlock[block.id]} compact />
      </Figure>

      {components.length > 0 && (
        <section className="stack">
          <Heading level={2} data-size="sm" style={{ margin: 0 }}>
            Byggeklosser
          </Heading>
          <ComponentGrid blockId={block.id} components={components} />
        </section>
      )}

      <div className="detail-grid">
        <div className="stack">
          <Tabs defaultValue="om" data-size="sm">
            <Tabs.List>
              <Tabs.Tab value="om">Om</Tabs.Tab>
              <Tabs.Tab value="kan">Hva den gir</Tabs.Tab>
              <Tabs.Tab value="kode">I koden</Tabs.Tab>
              {block.id === 'sprakmodeller' && <Tabs.Tab value="modeller">I katalogen</Tabs.Tab>}
            </Tabs.List>
            <Tabs.Panel value="om">
              <div className="prose" style={{ paddingTop: 'var(--ds-size-4)' }}>
                {block.description.map((p, i) => (
                  <Paragraph key={i}>{p}</Paragraph>
                ))}
              </div>
            </Tabs.Panel>
            <Tabs.Panel value="kan">
              <ul className="cap-list" style={{ paddingTop: 'var(--ds-size-4)' }}>
                {block.capabilities.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Tabs.Panel>
            <Tabs.Panel value="kode">
              <div className="stack" style={{ paddingTop: 'var(--ds-size-4)' }}>
                <Paragraph data-size="sm" style={{ margin: 0 }}>
                  Pakker i{' '}
                  <Link href="https://github.com/digdir/genki/tree/main/packages">
                    digdir/genki
                  </Link>
                  . Leverandørnavn finnes bare i providers-pakkene; en regel i{' '}
                  <code>npm run check</code> håndhever det.
                </Paragraph>
                <div className="pkg-list">
                  {block.packages.map((p) => (
                    <span key={p} className="pkg">
                      {p}
                    </span>
                  ))}
                </div>
                <Heading level={3} data-size="2xs" style={{ margin: 0 }}>
                  Arkitekturbeslutninger
                </Heading>
                <div className="table-scroll">
                  <Table data-size="sm" zebra>
                    <Table.Head>
                      <Table.Row>
                        <Table.HeaderCell>ADR</Table.HeaderCell>
                        <Table.HeaderCell>Tittel</Table.HeaderCell>
                      </Table.Row>
                    </Table.Head>
                    <Table.Body>
                      {block.adrs.map((a) => (
                        <Table.Row key={a.id}>
                          <Table.Cell>{a.id}</Table.Cell>
                          <Table.Cell>
                            <Link
                              href={`${ADR_BASE}${a.id}-${a.title
                                .toLowerCase()
                                .replace(/[^a-z0-9]+/g, '-')
                                .replace(/-$/, '')}.md`}
                            >
                              {a.title} <ExternalLinkIcon aria-hidden />
                            </Link>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
              </div>
            </Tabs.Panel>
            {block.id === 'sprakmodeller' && (
              <Tabs.Panel value="modeller">
                <div style={{ paddingTop: 'var(--ds-size-4)' }} className="table-scroll">
                  <Table data-size="sm" zebra>
                    <Table.Head>
                      <Table.Row>
                        <Table.HeaderCell>Modell</Table.HeaderCell>
                        <Table.HeaderCell>Leverandør</Table.HeaderCell>
                        <Table.HeaderCell>Residens</Table.HeaderCell>
                        <Table.HeaderCell>Status</Table.HeaderCell>
                      </Table.Row>
                    </Table.Head>
                    <Table.Body>
                      {models.map((m) => (
                        <Table.Row key={m.name}>
                          <Table.Cell>{m.name}</Table.Cell>
                          <Table.Cell>{m.provider}</Table.Cell>
                          <Table.Cell>{m.residency}</Table.Cell>
                          <Table.Cell>
                            <StatusTag status={m.status} />
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
              </Tabs.Panel>
            )}
          </Tabs>
        </div>

        <div className="stack">
          <Card className="reuse-box">
            <Card.Block>
              <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                Hvorfor gjenbrukbar
              </Heading>
            </Card.Block>
            <Card.Block>
              <Paragraph data-size="sm" style={{ margin: 0 }}>
                {block.reuse}
              </Paragraph>
            </Card.Block>
          </Card>
        </div>
      </div>

      <div className="pager" title="Piltast venstre og høyre bytter side">
        <Button variant="secondary" asChild>
          <a href={href({ page: 'byggeklosser', id: prev.id })}>
            <ChevronLeftIcon aria-hidden /> {prev.name}
          </a>
        </Button>
        <Button variant="secondary" asChild>
          <a href={href({ page: 'byggeklosser', id: next.id })}>
            {next.name} <ChevronRightIcon aria-hidden />
          </a>
        </Button>
      </div>
    </div>
  );
}
