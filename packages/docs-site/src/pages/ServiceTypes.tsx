import { Card, Heading, Link, Paragraph } from '@digdir/designsystemet-react';
import { TypeIcon } from '../components/icons';
import { serviceTypes } from '@genai/docs-content';
import { href } from '../router';
import { useContentLang, useDocumentTitle } from '../document';
import { useT } from '../i18n';

/** Oversikt over typene KI-tjenester man kan bygge på Genki. */
export function ServiceTypes() {
  const t = useT();
  const lang = useContentLang();
  useDocumentTitle(t('docsTypes.title'));
  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          {t('docsTypes.title')}
        </Heading>
        <Paragraph className="lede" style={{ margin: 0 }}>
          {t('docsTypes.lede')}
        </Paragraph>
      </div>

      <div className="grid">
        {serviceTypes.map((type) => (
          <div key={type.id}>
            <Card className="type-card link-card" style={{ height: '100%' }} lang={lang}>
              <div className="block-card-head">
                <span className="block-icon type-icon">
                  <TypeIcon id={type.id} />
                </span>
                <div>
                  <Heading level={2} data-size="xs" style={{ margin: 0 }}>
                    <Link href={href({ page: 'typer', id: type.id })}>{type.name}</Link>
                  </Heading>
                </div>
              </div>
              <Paragraph data-size="sm" style={{ margin: 0 }}>
                {type.intro}
              </Paragraph>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
