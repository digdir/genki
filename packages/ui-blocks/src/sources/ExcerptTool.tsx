import { Button, Card, Heading, Paragraph } from '@digdir/designsystemet-react';
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
} from '@navikt/aksel-icons';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { Markdown, visibleText, type MarkdownHighlight } from '../markdown/Markdown.js';
import { citedRange } from './citedRange.js';
import { excerptMarkdown, headingText } from './excerptMarkdown.js';
import { useT } from './i18n.js';
import type { Pairing } from './pairing.js';
import type {
  SourceDocument,
  SourceExcerpt,
  SourceSelection,
  SourceTarget,
  TextQuote,
} from './types.js';

type Level = 2 | 3 | 4 | 5 | 6;

interface Cited {
  chunkId: string;
  source: SourceDocument;
  excerpt: SourceExcerpt;
  name: string;
  numbers: readonly number[];
}

export interface ExcerptToolProps {
  sources: readonly SourceDocument[];
  names: readonly string[];
  /** Excerpt mode only. */
  pairing: Pairing;
  /** How many footnotes the answer has. */
  total: number;
  /** Index in the answer's footnotes; none shows every excerpt. */
  footnote: number | undefined;
  onFootnoteChange: (citation: number | undefined) => void;
  /** Without it, no «Åpne i dokumentvisning» button. */
  onOpenDocument?: ((selection: Required<SourceSelection>) => void) | undefined;
  /** Each request from outside to show a footnote, such as a footnote followed in the answer. */
  request?: SourceTarget | undefined;
  /** Escape, back to the footnote the reader followed in the answer. */
  onReturn?: (() => void) | undefined;
  /** The level of the shown document's title; its section is one under. */
  level: 2 | 3 | 4 | 5;
  /** Per footnote, the words it rests on, marked in its excerpt when it is shown whole. */
  quotes?: readonly (TextQuote | undefined)[] | undefined;
}

const yearOf = (date: string | undefined) => {
  const year = date ? new Date(date).getUTCFullYear() : Number.NaN;
  return Number.isNaN(year) ? undefined : String(year);
};

/** Kilder when the answer cites excerpts: every excerpt as a card, or one shown whole. */
export const ExcerptTool = ({
  sources,
  names,
  pairing,
  total,
  footnote,
  onFootnoteChange,
  onOpenDocument,
  request,
  onReturn,
  level,
  quotes,
}: ExcerptToolProps) => {
  const t = useT();
  const cards = useRef(new Map<string, HTMLElement>());
  const title = useRef<HTMLHeadingElement>(null);
  const stepped = useRef(false);
  const left = useRef<string | undefined>(undefined);

  // The map's order is the order of first citation.
  const cited = useMemo(
    () =>
      [...pairing.numbers.keys()].flatMap((chunkId): Cited[] => {
        const at = sources.findIndex((s) => s.excerpts.some((e) => e.chunkId === chunkId));
        const source = sources[at];
        const excerpt = source?.excerpts.find((e) => e.chunkId === chunkId);
        if (!source || !excerpt) return [];
        const numbers = (pairing.uses.get(chunkId) ?? []).map((i) => i + 1);
        return [{ chunkId, source, excerpt, name: names[at] || t('sources.untitled'), numbers }];
      }),
    [sources, names, pairing, t],
  );
  const target = footnote === undefined ? undefined : pairing.targets[footnote];
  const shown = target === undefined ? undefined : cited.find((c) => c.chunkId === target);
  const quote = footnote === undefined ? undefined : quotes?.[footnote];
  const shownText = shown ? excerptMarkdown(shown.excerpt.text) : '';
  const highlight = useMemo((): MarkdownHighlight | undefined => {
    if (!quote || !shownText) return undefined;
    const drawn = visibleText(shownText, false);
    const range = citedRange(shownText, drawn.text, quote);
    return range
      ? {
          hits: [{ itemId: 'cited', ...range, className: 'uib-sources-cited' }],
          offsets: drawn.offsets,
        }
      : undefined;
  }, [quote, shownText]);

  // Focus: the document on the way in, the step pressed on a step, the card on the way back.
  useEffect(() => {
    if (shown) {
      left.current = shown.chunkId;
      if (stepped.current) stepped.current = false;
      else title.current?.focus({ preventScroll: true });
      return;
    }
    const card = left.current === undefined ? undefined : cards.current.get(left.current);
    left.current = undefined;
    card?.focus();
  }, [shown?.chunkId, footnote, request]);

  const pageOf = (excerpt: SourceExcerpt) =>
    excerpt.page === undefined ? undefined : t('sources.pageShort', { page: excerpt.page });
  const sectionOf = (excerpt: SourceExcerpt) => {
    const path = headingText(excerpt.heading);
    return path?.split(' › ').at(-1);
  };

  if (shown && footnote !== undefined) {
    const step = (by: 1 | -1) => {
      let next = footnote;
      do next = (next + by + total) % total;
      while (next !== footnote && !cited.some((c) => c.chunkId === pairing.targets[next]));
      if (next === footnote) return;
      stepped.current = true;
      onFootnoteChange(next);
    };
    const meta = shown.source.meta?.length
      ? [...shown.source.meta]
      : [yearOf(shown.source.publishedAt), pageOf(shown.excerpt)];
    const section = sectionOf(shown.excerpt);
    return (
      <div
        className="uib-sources-ex-detail"
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== 'Escape' || !onReturn) return;
          event.preventDefault();
          onReturn();
        }}
      >
        <div className="uib-sources-ex-nav">
          <Button
            variant="tertiary"
            data-size="sm"
            data-color="neutral"
            className="uib-sources-ex-all"
            onClick={() => onFootnoteChange(undefined)}
          >
            <ArrowLeftIcon aria-hidden />
            {t('sources.allExcerpts')}
          </Button>
          <div className="uib-sources-ex-step" role="group" aria-label={t('sources.stepFootnotes')}>
            <Button
              variant="tertiary"
              data-size="sm"
              data-color="neutral"
              icon
              aria-label={t('sources.previousFootnote')}
              onClick={() => step(-1)}
            >
              <ChevronLeftIcon aria-hidden />
            </Button>
            <span className="uib-sources-ex-position" aria-live="polite">
              {t('sources.footnoteOf', { n: footnote + 1, total })}
            </span>
            <Button
              variant="tertiary"
              data-size="sm"
              data-color="neutral"
              icon
              aria-label={t('sources.nextFootnote')}
              onClick={() => step(1)}
            >
              <ChevronRightIcon aria-hidden />
            </Button>
          </div>
        </div>
        <div className="uib-sources-ex-head">
          <span className="uib-sources-ex-number" data-selected>
            {footnote + 1}
          </span>
          <div className="uib-sources-ex-titles">
            <Heading
              ref={title}
              level={level as Level}
              data-size="2xs"
              tabIndex={-1}
              className="uib-sources-ex-document"
            >
              {shown.name}
            </Heading>
            {meta.some(Boolean) ? (
              <span className="uib-sources-ex-meta">{meta.filter(Boolean).join(' · ')}</span>
            ) : null}
          </div>
        </div>
        {section ? (
          <Heading level={(level + 1) as Level} className="uib-sources-ex-section">
            {section}
          </Heading>
        ) : null}
        <div className="uib-sources-ex-text">
          {shown.excerpt.textUnavailable ? (
            <Paragraph data-size="sm">{t('sources.excerptUnavailable')}</Paragraph>
          ) : (
            <Markdown
              text={shownText}
              links={false}
              className="uib-markdown uib-sources-ex-quote"
              highlight={highlight}
            />
          )}
        </div>
        {onOpenDocument ? (
          <div>
            <Button
              variant="secondary"
              data-size="sm"
              data-color="accent"
              onClick={() => onOpenDocument({ source: shown.source, excerpt: shown.excerpt })}
            >
              <FileTextIcon aria-hidden />
              {t('sources.openInDocumentView')}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const documents = new Set(cited.map((c) => c.source)).size;
  return (
    <div className="uib-sources-ex-overview">
      <Paragraph data-size="xs" className="uib-sources-ex-lead">
        {t('sources.excerptsLead', {
          shown: t('sources.excerptsShown', { count: cited.length }),
          from: t('sources.excerptsFrom', { count: documents }),
        })}
      </Paragraph>
      <ol className="uib-sources-ex-list" aria-label={t('sources.excerptsList')}>
        {cited.map((c) => {
          const section = sectionOf(c.excerpt) ?? t('sources.excerptUnnumbered');
          const page = pageOf(c.excerpt);
          return (
            <li key={c.chunkId}>
              <Card asChild variant="tinted" data-color="neutral" className="uib-sources-ex-card">
                <button
                  type="button"
                  ref={(element) => {
                    if (element) cards.current.set(c.chunkId, element);
                    else cards.current.delete(c.chunkId);
                  }}
                  aria-label={t('sources.excerptCard', {
                    count: c.numbers.length,
                    numbers: c.numbers.join(` ${t('sources.and')} `),
                    title: section,
                    document: c.name,
                  })}
                  onClick={() => {
                    const first = c.numbers[0];
                    if (first !== undefined) onFootnoteChange(first - 1);
                  }}
                >
                  <span className="uib-sources-ex-top">
                    <span className="uib-sources-ex-numbers">
                      {c.numbers.map((n) => (
                        <span key={n} className="uib-sources-ex-number">
                          {n}
                        </span>
                      ))}
                    </span>
                    <span className="uib-sources-ex-doc">
                      {page ? `${c.name} · ${page}` : c.name}
                    </span>
                  </span>
                  <span className="ds-heading uib-sources-ex-title" data-size="2xs">
                    {section}
                  </span>
                  <span className="ds-paragraph uib-sources-ex-preview" data-size="sm">
                    {c.excerpt.textUnavailable
                      ? t('sources.excerptUnavailable')
                      : visibleText(excerptMarkdown(c.excerpt.text), false).text}
                  </span>
                </button>
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
};
