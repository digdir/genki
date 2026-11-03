import { Button, Card, Heading, Paragraph } from '@digdir/designsystemet-react';
import { ArrowRightIcon } from '@navikt/aksel-icons';
import { ArchitectureDiagram } from '../components/ArchitectureDiagram';
import { Figure } from '../components/Figure';
import { HeroStack } from '../components/HeroStack';
import { links } from '../data/blocks';
import { href } from '../router';

export function Overview() {
  return (
    <div className="stack-lg">
      <section className="hero">
        <div className="stack">
          <div>
            <Heading level={1} data-size="xl" style={{ margin: 0 }}>
              Genki: byggeklosser for generativ KI i offentlig sektor
            </Heading>
          </div>
          <p className="lede">
            En åpen nasjonal fellesløsning fra Digdir. En virksomhet beskriver en KI-tjeneste i en
            kort definisjon, og plattformen kjører den med modeller, kilder, tilgang, kostnad og
            kvalitetssjekker innebygd. Bygd én gang, for hele forvaltningen.
          </p>
          <div className="cluster">
            <Button asChild>
              <a href={href({ page: 'byggeklosser' })}>
                Utforsk byggeklossene <ArrowRightIcon aria-hidden />
              </a>
            </Button>
            <Button variant="secondary" asChild>
              <a href={href({ page: 'tjenester' })}>Se flyten gjennom plattformen</a>
            </Button>
            <Button variant="tertiary" asChild>
              <a href={links.repo}>Kildekoden på GitHub</a>
            </Button>
          </div>
        </div>
        <Figure
          className="hero-visual"
          label="Lagene i Genki"
          keyboardNav="focus"
          hint="Piltastene flytter markeringen, Enter åpner. Esc lukker."
        >
          <HeroStack />
        </Figure>
      </section>

      <section className="stack">
        <div className="section-head">
          <div>
            <p className="fig-caption">Fellesløsning målarkitektur</p>
            <Heading level={2} data-size="md" style={{ margin: 0 }}>
              Arkitekturen, lag for lag
            </Heading>
            <Paragraph
              data-size="sm"
              style={{
                margin: 0,
                color: 'var(--ds-color-neutral-text-subtle)',
              }}
            >
              Klikk på et lag for å åpne den overordnede byggeklossen.
            </Paragraph>
          </div>
        </div>
        <Figure
          className="diagram-wrap"
          label="Målarkitekturen"
          keyboardNav="figure"
          hint="Piltastene flytter markeringen, Enter åpner. Esc lukker."
        >
          <ArchitectureDiagram />
        </Figure>
      </section>

      <section className="stack together">
        <div>
          <p className="fig-caption">Åpen kildekode og fellesskap</p>
          <Heading level={2} data-size="md" style={{ margin: 0 }}>
            Vi bygger sammen
          </Heading>
        </div>
        <Paragraph className="lede" style={{ margin: 0 }}>
          Genki er åpen kildekode under MIT-lisens, og bygges på tvers av norsk offentlig sektor.
          Det Digdir bygger i fellesløsningen og det andre virksomheter bidrar med, blir én felles
          verktøykasse i stedet for mange like.
        </Paragraph>
        <div className="grid">
          {[
            {
              t: 'Åpen kode',
              d: 'All kode, alle arkitekturbeslutninger og all dokumentasjon ligger åpent på GitHub. Alle kan lese, bruke og foreslå endringer.',
              href: links.repo,
              cta: 'digdir/genki på GitHub',
            },
            {
              t: 'På tvers av forvaltningen',
              d: 'Stat og kommune deler byggeklosser i stedet for å bygge hver sin KI-plattform. Én virksomhet bygger en tjeneste, alle kan gjenbruke den.',
              href: href({ page: 'kom-i-gang' }),
              cta: 'Slik kommer du i gang',
            },
            {
              t: 'Bidra',
              d: 'Nye arbeidsmåter, verktøy, datasett-kilder og modeller kommer inn som pakker bak faste kontrakter. Beslutninger tas åpent i ADR-er.',
              href: links.adr,
              cta: 'Les arkitekturbeslutningene',
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
    </div>
  );
}
