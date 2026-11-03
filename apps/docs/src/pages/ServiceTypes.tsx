import { Card, Heading, Link, Paragraph } from '@digdir/designsystemet-react';
import { TypeIcon } from '../components/icons';
import { serviceTypes } from '../data/serviceTypes';
import { href } from '../router';

/** Oversikt over typene KI-tjenester man kan bygge på Genki. */
export function ServiceTypes() {
  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          Typer KI-tjenester
        </Heading>
        <Paragraph className="lede" style={{ margin: 0 }}>
          Fire typer tjenester kan bygges på de samme byggeklossene. Forskjellen ligger i hvem
          tjenesten er for, hva den får tilgang til, og om den bare svarer eller også handler.
        </Paragraph>
      </div>

      <div className="grid">
        {serviceTypes.map((t) => (
          <div key={t.id}>
            <Card className="type-card" style={{ height: '100%' }}>
              <Card.Block>
                <div className="block-card-head">
                  <span className="block-icon type-icon">
                    <TypeIcon id={t.id} />
                  </span>
                  <div>
                    <Heading level={2} data-size="xs" style={{ margin: 0 }}>
                      <Link href={href({ page: 'typer', id: t.id })}>{t.name}</Link>
                    </Heading>
                  </div>
                </div>
              </Card.Block>
              <Card.Block>
                <Paragraph data-size="sm" style={{ margin: 0 }}>
                  {t.intro}
                </Paragraph>
              </Card.Block>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
