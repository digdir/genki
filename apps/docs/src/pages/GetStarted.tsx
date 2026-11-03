import { Card, Details, Heading, Link, List, Paragraph, Table } from '@digdir/designsystemet-react';
import { links } from '../data/blocks';

export function GetStarted() {
  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          Kom i gang
        </Heading>
        <Paragraph className="lede" style={{ margin: 0 }}>
          Genki kjører lokalt uten hemmeligheter: pålogging, rettigheter og en testmodell er mocket.
          Du trenger mise og Docker.
        </Paragraph>
      </div>

      <section className="stack">
        <Heading level={2} data-size="md" style={{ margin: 0 }}>
          Kjør plattformen lokalt
        </Heading>
        <pre className="code">{`git clone https://github.com/digdir/genki
cd genki
mise trust && mise install   # Node 24
npm start                    # setup + api, portal, konsoll og arbeidsflate`}</pre>
        <div className="table-scroll">
          <Table data-size="sm" zebra>
            <Table.Head>
              <Table.Row>
                <Table.HeaderCell>Adresse</Table.HeaderCell>
                <Table.HeaderCell>App</Table.HeaderCell>
                <Table.HeaderCell>For</Table.HeaderCell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              <Table.Row>
                <Table.Cell>localhost:5176</Table.Cell>
                <Table.Cell>Arbeidsflate</Table.Cell>
                <Table.Cell>Ansatte: chat med publiserte tjenester, med kilder</Table.Cell>
              </Table.Row>
              <Table.Row>
                <Table.Cell>localhost:5173</Table.Cell>
                <Table.Cell>Portal</Table.Cell>
                <Table.Cell>Virksomheter: bygg, test og publiser tjenester</Table.Cell>
              </Table.Row>
              <Table.Row>
                <Table.Cell>localhost:5174</Table.Cell>
                <Table.Cell>Konsoll</Table.Cell>
                <Table.Cell>
                  Digdir-operatører: organisasjoner, modeller, delte tjenester
                </Table.Cell>
              </Table.Row>
              <Table.Row>
                <Table.Cell>localhost:8080/reference</Table.Cell>
                <Table.Cell>API-referanse</Table.Cell>
                <Table.Cell>Utviklere: alle operasjoner, søkbart</Table.Cell>
              </Table.Row>
            </Table.Body>
          </Table>
        </div>
      </section>

      <section className="stack">
        <Heading level={2} data-size="md" style={{ margin: 0 }}>
          Kall en tjeneste fra egen kode
        </Heading>
        <Paragraph style={{ margin: 0 }}>
          Alt appene gjør går gjennom samme API. En tjeneste er en OpenAI-kompatibel modell:
        </Paragraph>
        <pre className="code">{`curl -s http://localhost:8080/v1/chat/completions \\
  -H "Authorization: Bearer $DEV_API_KEY" -H 'Content-Type: application/json' \\
  -d '{"model":"local-test-chat__default","messages":[{"role":"user","content":"Hei!"}]}'`}</pre>
        <Details>
          <Details.Summary>De andre kanalene</Details.Summary>
          <Details.Content>
            <List.Unordered>
              <List.Item>
                <strong>MCP:</strong> POST /api/mcp, ett verktøy per variant
              </List.Item>
              <List.Item>
                <strong>A2A:</strong> GET /a2a for agentkort, POST /a2a/:agent
              </List.Item>
              <List.Item>
                <strong>REST:</strong> /api/datasets, /api/facets, /api/conversations, /api/feedback
              </List.Item>
            </List.Unordered>
          </Details.Content>
        </Details>
      </section>

      <section className="stack">
        <Heading level={2} data-size="md" style={{ margin: 0 }}>
          Les videre
        </Heading>
        <div className="grid">
          {[
            {
              t: 'Repoet',
              d: 'README, kode og issues for digdir/genki',
              u: links.repo,
            },
            {
              t: 'Arkitekturbeslutninger',
              d: 'Hver ADR sier om den er bygd, og hva som mangler',
              u: links.adr,
            },
            {
              t: 'API-guider',
              d: 'Pålogging, rettigheter, feil og en guide per område',
              u: links.api,
            },
            {
              t: 'Bygg en frontend',
              d: 'Korteste vei til din egen frontend på API-et',
              u: links.frontend,
            },
            {
              t: 'Egen logikk',
              d: 'Et verktøysteg eller en hel motor du kjører selv',
              u: links.byol,
            },
            {
              t: 'digdir-headless-rag',
              d: 'Løsningen Genki erstatter, målt med parity-harnesset',
              u: links.headlessRag,
            },
          ].map((l) => (
            <Card key={l.u} asChild data-color="neutral" className="block-card">
              <a href={l.u} style={{ textDecoration: 'none', color: 'inherit' }}>
                <Card.Block>
                  <Heading level={3} data-size="2xs" style={{ margin: 0 }}>
                    {l.t}
                  </Heading>
                  <Paragraph data-size="sm" style={{ margin: 0 }}>
                    {l.d}
                  </Paragraph>
                </Card.Block>
              </a>
            </Card>
          ))}
        </div>
        <Paragraph
          data-size="sm"
          style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
        >
          Denne visualiseringen er ikke en del av Genki. Les kildene for det som gjelder, se{' '}
          <Link href={links.repo}>repoet</Link>.
        </Paragraph>
      </section>
    </div>
  );
}
