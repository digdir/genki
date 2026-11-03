import { Card, Heading, Link, Paragraph, Search, Tag } from '@digdir/designsystemet-react';
import { useState } from 'react';
import { navigate } from '../router';
import { search, typeLabel } from '../search';

/** Resultatside bak #/sok?q=…, så et søk kan deles og bokmerkes. */
export function SearchPage({ q = '' }: { q?: string }) {
  const [draft, setDraft] = useState(q);
  const hits = search(q, 50);

  return (
    <div className="stack-lg">
      <div className="stack">
        <Heading level={1} data-size="lg" style={{ margin: 0 }}>
          Søk
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
              aria-label="Søk på nettstedet"
              placeholder="Søk i byggeklosser, flyter og typer"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
            />
            <Search.Clear onClick={() => setDraft('')} />
            <Search.Button>Søk</Search.Button>
          </Search>
        </form>
        {q && (
          <Paragraph
            data-size="sm"
            style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
          >
            {hits.length ? `${hits.length} treff for «${q}»` : `Ingen treff for «${q}»`}
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
                      <Link href={h.to} data-size="md">
                        {h.title}
                      </Link>
                      {h.context && <span className="search-context">{h.context}</span>}
                    </span>
                    <Paragraph
                      data-size="xs"
                      style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
                    >
                      {h.excerpt}
                    </Paragraph>
                  </div>
                  <Tag data-size="sm" data-color="neutral">
                    {typeLabel[h.type]}
                  </Tag>
                </div>
              </Card.Block>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
