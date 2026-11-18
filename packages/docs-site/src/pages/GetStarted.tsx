import { Card, Details, Heading, Link, List, Paragraph, Table } from '@digdir/designsystemet-react';
import { links } from '@genai/docs-content';
import { useDocumentTitle } from '../document';
import { useT } from '../i18n';

const apps = [
  ['localhost:5176', 'docsGetStarted.workspace', 'docsGetStarted.workspaceFor'],
  ['localhost:5173', 'docsGetStarted.portal', 'docsGetStarted.portalFor'],
  ['localhost:5174', 'docsGetStarted.console', 'docsGetStarted.consoleFor'],
  ['localhost:8080/reference', 'docsGetStarted.reference', 'docsGetStarted.referenceFor'],
] as const;

const reading = [
  ['docsGetStarted.repo', 'docsGetStarted.repoBody', links.repo],
  ['docsGetStarted.adr', 'docsGetStarted.adrBody', links.adr],
  ['docsGetStarted.api', 'docsGetStarted.apiBody', links.api],
  ['docsGetStarted.frontend', 'docsGetStarted.frontendBody', links.frontend],
  ['docsGetStarted.logic', 'docsGetStarted.logicBody', links.byol],
  ['docsGetStarted.headless', 'docsGetStarted.headlessBody', links.headlessRag],
] as const;

export function GetStarted() {
  const t = useT();
  useDocumentTitle(t('docsGetStarted.title'));
  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          {t('docsGetStarted.title')}
        </Heading>
        <Paragraph className="lede" style={{ margin: 0 }}>
          {t('docsGetStarted.lede')}
        </Paragraph>
      </div>

      <section className="stack">
        <Heading level={2} data-size="sm" style={{ margin: 0 }}>
          {t('docsGetStarted.run')}
        </Heading>
        <pre className="code">{`git clone https://github.com/digdir/genki
cd genki
mise trust && mise install   # Node 24
npm start                    # ${t('docsGetStarted.runComment')}`}</pre>
        <div className="table-scroll">
          <Table data-size="sm" zebra className="stack-table">
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell scope="col">{t('docsGetStarted.address')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('docsGetStarted.app')}</Table.HeaderCell>
                <Table.HeaderCell scope="col">{t('docsGetStarted.for')}</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {apps.map(([address, app, purpose]) => (
                <Table.Row key={address}>
                  <Table.Cell data-label={t('docsGetStarted.address')}>{address}</Table.Cell>
                  <Table.Cell data-label={t('docsGetStarted.app')}>{t(app)}</Table.Cell>
                  <Table.Cell data-label={t('docsGetStarted.for')}>{t(purpose)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      </section>

      <section className="stack">
        <Heading level={2} data-size="sm" style={{ margin: 0 }}>
          {t('docsGetStarted.call')}
        </Heading>
        <Paragraph style={{ margin: 0 }}>{t('docsGetStarted.callLede')}</Paragraph>
        <pre className="code">{`curl -s http://localhost:8080/v1/chat/completions \\
  -H "Authorization: Bearer $DEV_API_KEY" -H 'Content-Type: application/json' \\
  -d '{"model":"local-test-chat__default","messages":[{"role":"user","content":"Hei!"}]}'`}</pre>
        <Details>
          <Details.Summary>{t('docsGetStarted.channels')}</Details.Summary>
          <Details.Content>
            <List.Unordered>
              <List.Item>
                <strong>MCP:</strong> {t('docsGetStarted.mcp')}
              </List.Item>
              <List.Item>
                <strong>A2A:</strong> {t('docsGetStarted.a2a')}
              </List.Item>
              <List.Item>
                <strong>REST:</strong> {t('docsGetStarted.rest')}
              </List.Item>
            </List.Unordered>
          </Details.Content>
        </Details>
      </section>

      <section className="stack">
        <Heading level={2} data-size="sm" style={{ margin: 0 }}>
          {t('docsGetStarted.read')}
        </Heading>
        <div className="grid">
          {reading.map(([title, body, url]) => (
            <Card key={url} asChild data-color="neutral" className="link-card">
              <a href={url}>
                <Heading level={3} data-size="2xs">
                  {t(title)}
                </Heading>
                <Paragraph data-size="sm">{t(body)}</Paragraph>
              </a>
            </Card>
          ))}
        </div>
        <Paragraph
          data-size="sm"
          style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
        >
          {t.rich('docsGetStarted.footnote', { link: (c) => <Link href={links.repo}>{c}</Link> })}
        </Paragraph>
      </section>
    </div>
  );
}
