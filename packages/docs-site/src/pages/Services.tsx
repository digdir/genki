import { Card, Heading, Link, Paragraph } from '@digdir/designsystemet-react';
import { cases } from '@genai/docs-content';
import { href } from '../router';
import { useContentLang, useDocumentTitle } from '../document';
import { useT } from '../i18n';

const sorted = [...cases].sort((a, b) => a.name.localeCompare(b.name, 'nb'));

/** Liste over flyter. Nye flyter legges til i `cases` i packages/docs-content/src/blocks.ts. */
export function Services() {
  const t = useT();
  const lang = useContentLang();
  useDocumentTitle(t('docsFlow.title'));
  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          {t('docsFlow.title')}
        </Heading>
        <Paragraph className="lede" style={{ margin: 0 }}>
          {t('docsFlow.lede')}
        </Paragraph>
      </div>

      <div className="grid">
        {sorted.map((c) => (
          <div key={c.id}>
            <Card className="case-card link-card" style={{ height: '100%' }} lang={lang}>
              <Heading level={2} data-size="xs" style={{ margin: 0 }}>
                <Link href={href({ page: 'tjenester', id: c.id })}>{c.name}</Link>
              </Heading>
              <Paragraph data-size="sm" style={{ margin: 0 }}>
                {c.intro}
              </Paragraph>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
