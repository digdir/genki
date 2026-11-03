import { Card, Heading, Link, Paragraph } from '@digdir/designsystemet-react';
import { cases } from '../data/blocks';

const sorted = [...cases].sort((a, b) => a.name.localeCompare(b.name, 'nb'));
import { href } from '../router';

/** Liste over flyter. Nye flyter legges til i `cases` i src/data/blocks.ts. */
export function Services() {
  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          Flyt
        </Heading>
        <Paragraph className="lede" style={{ margin: 0 }}>
          KI-tjenester vist steg for steg gjennom byggeklossene. Hver flyt har to deler: bruk av
          tjenesten, fra noen spør til svaret kommer, og oppsett i Genki, det tjenesteeier gjør for
          å lage og publisere den.
        </Paragraph>
      </div>

      <div className="grid">
        {sorted.map((c) => (
          <div key={c.id}>
            <Card className="case-card" style={{ height: '100%' }}>
              <Card.Block>
                <Heading level={2} data-size="xs" style={{ margin: 0 }}>
                  <Link href={href({ page: 'tjenester', id: c.id })}>{c.name}</Link>
                </Heading>
              </Card.Block>
              <Card.Block>
                <Paragraph data-size="sm" style={{ margin: 0 }}>
                  {c.intro}
                </Paragraph>
              </Card.Block>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
