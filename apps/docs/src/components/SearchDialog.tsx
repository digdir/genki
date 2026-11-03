import { Dialog, Link, Paragraph, Search, Tag } from '@digdir/designsystemet-react';
import { useEffect, useRef, useState } from 'react';
import { href, navigate } from '../router';
import { search, suggestions, typeLabel, type SearchDoc } from '../search';

/**
 * Søk over hele nettstedet: dialog fra headeren eller Ctrl/Cmd+K.
 * Piltaster flytter mellom treffene, Enter åpner, Esc lukker.
 */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);

  const hits: SearchDoc[] = q.trim().length >= 2 ? search(q, 12) : suggestions;
  const isSuggestion = q.trim().length < 2;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQ('');
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  useEffect(() => setCursor(0), [q]);

  const openHit = (h: SearchDoc) => {
    onClose();
    window.location.hash = h.to;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (hits.length ? (c + 1) % hits.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (hits.length ? (c - 1 + hits.length) % hits.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hits[cursor]) openHit(hits[cursor]);
      else if (q.trim()) {
        onClose();
        navigate({ page: 'sok', q: q.trim() });
      }
    }
  };

  return (
    <Dialog
      ref={ref}
      className="search-dialog"
      closedby="any"
      onClose={onClose}
      closeButton="Lukk søk"
      placement="top"
    >
      <div className="search-box" onKeyDown={onKeyDown}>
        <Search>
          <Search.Input
            ref={inputRef}
            aria-label="Søk på nettstedet"
            placeholder="Søk i byggeklosser, flyter og typer"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
          />
          <Search.Clear onClick={() => setQ('')} />
        </Search>
        <Paragraph
          data-size="xs"
          style={{ margin: 0, color: 'var(--ds-color-neutral-text-subtle)' }}
        >
          {isSuggestion
            ? 'Hurtignavigasjon. Skriv for å søke.'
            : hits.length
              ? `${hits.length} treff. Piltaster og Enter.`
              : 'Ingen treff.'}
        </Paragraph>
        <ul className="search-results" role="listbox" aria-label="Treff">
          {hits.map((h, i) => (
            <li
              key={h.id}
              role="option"
              aria-selected={i === cursor}
              className={i === cursor ? 'is-cursor' : undefined}
              onMouseEnter={() => setCursor(i)}
            >
              <a
                href={h.to}
                onClick={(e) => {
                  e.preventDefault();
                  openHit(h);
                }}
              >
                <span className="search-title">
                  <Tag data-size="sm" data-color="neutral">
                    {typeLabel[h.type]}
                  </Tag>
                  <strong>{h.title}</strong>
                  {h.context && <span className="search-context">{h.context}</span>}
                </span>
                {!isSuggestion && <span className="search-excerpt">{h.excerpt}</span>}
              </a>
            </li>
          ))}
        </ul>
        {!isSuggestion && q.trim() && (
          <Link href={href({ page: 'sok', q: q.trim() })} data-size="sm" onClick={onClose}>
            Vis alle treff for «{q.trim()}»
          </Link>
        )}
      </div>
    </Dialog>
  );
}
