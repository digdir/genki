import { Alert, Button, Card, Heading, Link, Paragraph } from '@digdir/designsystemet-react';
import { ChevronLeftIcon, ChevronRightIcon } from '@navikt/aksel-icons';
import { BlockIcon, TypeIcon } from '../components/icons';
import { blockById, caseById } from '../data/blocks';
import { serviceTypeById, serviceTypes } from '../data/serviceTypes';
import { usePagerKeys } from '../components/usePagerKeys';
import { href } from '../router';

/** Én type KI-tjeneste: hva den er, når den passer, hvordan den bygges på Genki, og eksempler. */
export function ServiceTypeDetail({ id }: { id: string }) {
  const t = serviceTypeById(id);
  if (!t) {
    return (
      <div className="stack">
        <Alert data-color="warning">Fant ingen tjenestetype med id «{id}».</Alert>
        <Link href={href({ page: 'typer' })}>Til alle typene</Link>
      </div>
    );
  }
  const idx = serviceTypes.indexOf(t);
  const prev = serviceTypes[(idx - 1 + serviceTypes.length) % serviceTypes.length];
  const next = serviceTypes[(idx + 1) % serviceTypes.length];
  usePagerKeys({ page: 'typer', id: prev.id }, { page: 'typer', id: next.id });
  const flows = t.cases.map((c) => caseById(c)).filter((c) => c !== undefined);

  return (
    <div className="stack-lg">
      <div className="stack">
        <Link href={href({ page: 'typer' })}>
          <ChevronLeftIcon aria-hidden /> Alle typer KI-tjenester
        </Link>
        <div className="detail-head">
          <span className="detail-icon type-icon">
            <TypeIcon id={t.id} />
          </span>
          <div className="stack" style={{ gap: 'var(--ds-size-2)' }}>
            <Paragraph
              data-size="xs"
              style={{
                margin: 0,
                color: 'var(--ds-color-neutral-text-subtle)',
              }}
            >
              Type KI-tjeneste
            </Paragraph>
            <Heading level={1} data-size="lg" style={{ margin: 0 }}>
              {t.name}
            </Heading>
            <Paragraph className="lede" style={{ margin: 0 }}>
              {t.tagline}
            </Paragraph>
          </div>
        </div>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <Paragraph style={{ margin: 0 }}>{t.intro}</Paragraph>
          <div className="prose">
            {t.description.map((p, i) => (
              <Paragraph key={i}>{p}</Paragraph>
            ))}
          </div>

          <Heading level={2} data-size="sm" style={{ margin: 0 }}>
            Slik bygges den på Genki
          </Heading>
          <ol className="build-list">
            {t.build.map((b) => {
              const block = b.block ? blockById(b.block) : undefined;
              return (
                <li key={b.label}>
                  <span className="build-label">{b.label}</span>
                  <span className="build-text">
                    {b.text}
                    {block && (
                      <>
                        {' '}
                        <Link href={href({ page: 'byggeklosser', id: block.id })} data-size="sm">
                          <BlockIcon id={block.id} className="inline-icon" /> {block.name}
                        </Link>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="stack">
          <Card className="reuse-box">
            <Card.Block>
              <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                Passer når
              </Heading>
            </Card.Block>
            <Card.Block>
              <ul className="cap-list compact">
                {t.fits.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </Card.Block>
          </Card>
          <Card className="reuse-box">
            <Card.Block>
              <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                Velg noe annet når
              </Heading>
            </Card.Block>
            <Card.Block>
              <ul className="cap-list compact">
                {t.avoid.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </Card.Block>
          </Card>
          <Card className="reuse-box">
            <Card.Block>
              <Heading level={2} data-size="2xs" style={{ margin: 0 }}>
                Eksempler
              </Heading>
            </Card.Block>
            <Card.Block>
              <ul className="cap-list compact">
                {t.examples.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </Card.Block>
          </Card>
        </div>
      </div>

      {flows.length > 0 && (
        <section className="stack">
          <div>
            <p className="fig-caption">Steg for steg</p>
            <Heading level={2} data-size="md" style={{ margin: 0 }}>
              Flyter som viser {t.name.toLowerCase()}
            </Heading>
          </div>
          <div className="grid">
            {flows.map((c) => (
              <Card key={c.id} className="case-card" style={{ height: '100%' }}>
                <Card.Block>
                  <div
                    className="cluster"
                    style={{
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Heading level={3} data-size="xs" style={{ margin: 0 }}>
                      <Link href={href({ page: 'tjenester', id: c.id })}>{c.name}</Link>
                    </Heading>
                  </div>
                </Card.Block>
              </Card>
            ))}
          </div>
        </section>
      )}

      <div className="pager" title="Piltast venstre og høyre bytter side">
        <Button variant="secondary" asChild>
          <a href={href({ page: 'typer', id: prev.id })}>
            <ChevronLeftIcon aria-hidden /> {prev.name}
          </a>
        </Button>
        <Button variant="secondary" asChild>
          <a href={href({ page: 'typer', id: next.id })}>
            {next.name} <ChevronRightIcon aria-hidden />
          </a>
        </Button>
      </div>
    </div>
  );
}
