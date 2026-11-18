import { Button, Card, Heading, Link, Paragraph, Table, Tabs } from '@digdir/designsystemet-react';
import { ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from '@navikt/aksel-icons';
import { ArchitectureDiagram, nodeForBlock, toneForBlock } from '../components/ArchitectureDiagram';
import { Figure } from '../components/Figure';
import { BlockIcon } from '../components/icons';
import { adrUrl, blockById, blocks, models, componentsFor } from '@genai/docs-content';
import { BackLink } from '../components/BackLink';
import { ComponentGrid } from '../components/ComponentGrid';
import { NotFound } from '../components/NotFound';
import { StatusTag } from '../components/StatusTag';
import { usePagerKeys } from '../components/usePagerKeys';
import { href } from '../router';
import { useContentLang, useDocumentTitle } from '../document';
import { useT } from '../i18n';

export function BlockDetail({ id }: { id: string }) {
  const t = useT();
  const lang = useContentLang();
  const block = blockById(id);
  useDocumentTitle(block?.name ?? t('docsBlocks.notFoundTitle'));
  if (!block) {
    return (
      <NotFound
        title={t('docsBlocks.notFoundTitle')}
        message={t('docsBlocks.notFound', { id })}
        back={{ href: href({ page: 'byggeklosser' }), label: t('docsBlocks.toAll') }}
      />
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
        <BackLink href={href({ page: 'byggeklosser' })}>{t('docsCommon.allBlocks')}</BackLink>
        <div className="detail-head">
          <span className="detail-icon">
            <BlockIcon id={block.id} />
          </span>
          <div className="stack" style={{ gap: 'var(--ds-size-2)' }}>
            <Heading level={1} data-size="lg" style={{ margin: 0 }} lang={lang}>
              {block.name}
            </Heading>
            <Paragraph className="lede" style={{ margin: 0 }} lang={lang}>
              {block.tagline}
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
        <ArchitectureDiagram highlight={nodeForBlock[block.id]} compact />
      </Figure>

      {components.length > 0 && (
        <section className="stack">
          <Heading level={2} data-size="sm" style={{ margin: 0 }}>
            {t('docsCommon.blocks')}
          </Heading>
          <ComponentGrid blockId={block.id} components={components} />
        </section>
      )}

      <div className="detail-grid">
        <div className="stack">
          <Tabs defaultValue="om" data-size="sm">
            <Tabs.List>
              <Tabs.Tab value="om">{t('docsBlocks.tabAbout')}</Tabs.Tab>
              <Tabs.Tab value="kan">{t('docsBlocks.tabGives')}</Tabs.Tab>
              <Tabs.Tab value="kode">{t('docsBlocks.tabCode')}</Tabs.Tab>
              {block.id === 'sprakmodeller' && (
                <Tabs.Tab value="modeller">{t('docsBlocks.tabModels')}</Tabs.Tab>
              )}
            </Tabs.List>
            <Tabs.Panel value="om">
              <div className="prose" style={{ paddingTop: 'var(--ds-size-4)' }}>
                {block.description.map((p, i) => (
                  <Paragraph key={i} lang={lang}>
                    {p}
                  </Paragraph>
                ))}
              </div>
            </Tabs.Panel>
            <Tabs.Panel value="kan">
              <ul className="cap-list" style={{ paddingTop: 'var(--ds-size-4)' }}>
                {block.capabilities.map((c) => (
                  <li key={c} lang={lang}>
                    {c}
                  </li>
                ))}
              </ul>
            </Tabs.Panel>
            <Tabs.Panel value="kode">
              <div className="stack" style={{ paddingTop: 'var(--ds-size-4)' }}>
                <Paragraph data-size="sm" style={{ margin: 0 }}>
                  {t.rich('docsBlocks.codeIntro', {
                    link: (c) => (
                      <Link href="https://github.com/digdir/genki/tree/main/packages">{c}</Link>
                    ),
                    code: (c) => <code>{c}</code>,
                  })}
                </Paragraph>
                <div className="pkg-list">
                  {block.packages.map((p) => (
                    <span key={p} className="pkg">
                      {p}
                    </span>
                  ))}
                </div>
                <Heading level={3} data-size="2xs" style={{ margin: 0 }}>
                  {t('docsBlocks.adrs')}
                </Heading>
                <div className="table-scroll">
                  <Table data-size="sm" zebra>
                    <Table.Head>
                      <Table.Row>
                        <Table.HeaderCell scope="col">{t('docsBlocks.adr')}</Table.HeaderCell>
                        <Table.HeaderCell scope="col">{t('docsBlocks.adrTitle')}</Table.HeaderCell>
                      </Table.Row>
                    </Table.Head>
                    <Table.Body>
                      {block.adrs.map((a) => (
                        <Table.Row key={a.id}>
                          <Table.Cell>{a.id}</Table.Cell>
                          <Table.Cell lang={lang}>
                            <Link href={adrUrl(a)}>
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
                        <Table.HeaderCell scope="col">{t('docsBlocks.model')}</Table.HeaderCell>
                        <Table.HeaderCell scope="col">{t('docsBlocks.provider')}</Table.HeaderCell>
                        <Table.HeaderCell scope="col">{t('docsBlocks.residency')}</Table.HeaderCell>
                        <Table.HeaderCell scope="col">{t('docsBlocks.status')}</Table.HeaderCell>
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
                {t('docsBlocks.whyReusable')}
              </Heading>
            </Card.Block>
            <Card.Block>
              <Paragraph data-size="sm" style={{ margin: 0 }} lang={lang}>
                {block.reuse}
              </Paragraph>
            </Card.Block>
          </Card>
        </div>
      </div>

      <div className="pager" title={t('docsCommon.pagerTitle')}>
        <Button variant="secondary" asChild>
          <a href={href({ page: 'byggeklosser', id: prev.id })} lang={lang}>
            <ChevronLeftIcon aria-hidden /> {prev.name}
          </a>
        </Button>
        <Button variant="secondary" asChild>
          <a href={href({ page: 'byggeklosser', id: next.id })} lang={lang}>
            {next.name} <ChevronRightIcon aria-hidden />
          </a>
        </Button>
      </div>
    </div>
  );
}
