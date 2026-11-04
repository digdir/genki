import { Card, Heading, Link, Paragraph, Search, Tag } from '@digdir/designsystemet-react';
import { useEffect, useState } from 'react';
import { navigate } from '../router';
import { search, typeLabel, typeTagNb } from '../search';
import { useContentLang, useDocumentTitle } from '../document';
import { useT } from '../i18n';

/** Resultatside bak #/sok?q=…, så et søk kan deles og bokmerkes. */
export function SearchPage({ q = '' }: { q?: string }) {
  const t = useT();
  const lang = useContentLang();
  useDocumentTitle(t('docsSearch.title'));
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const hits = search(q, 50);

  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          {t('docsSearch.title')}
        </Heading>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ page: 'sok', q: draft.trim() || undefined });
          }}
          className="search-form"
        >
          <Search>
            <Search.Input
              aria-label={t('docsSearch.label')}
              placeholder={t('docsSearch.placeholder')}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
            />
            <Search.Clear onClick={() => setDraft('')} />
            <Search.Button>{t('docsSearch.button')}</Search.Button>
          </Search>
        </form>
        {q && (
          <Paragraph
            data-size="sm"
            style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
          >
            {hits.length
              ? t('docsSearch.hitsFor', { count: hits.length, query: q })
              : t('docsSearch.noneFor', { query: q })}
          </Paragraph>
        )}
      </div>

      <ul className="status-list">
        {hits.map((h) => (
          <li key={h.id}>
            <Card className="status-card">
              <Card.Block>
                <div className="status-row">
                  <div>
                    <span className="search-title">
                      <Tag data-size="sm" data-color="neutral" lang={lang}>
                        {lang ? typeTagNb(h.type) : t(typeLabel[h.type])}
                      </Tag>
                      <Link href={h.to} data-size="md" lang={lang}>
                        {h.title}
                      </Link>
                      {h.context && (
                        <span className="search-context" lang={lang}>
                          {h.context}
                        </span>
                      )}
                    </span>
                    <Paragraph
                      data-size="xs"
                      lang={lang}
                      style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
                    >
                      {h.excerpt}
                    </Paragraph>
                  </div>
                </div>
              </Card.Block>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
