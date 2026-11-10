import { Field, Label, Link, Paragraph, Select } from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useState } from 'react';
import { freshText, useFilterAnnouncer } from '../filter/announce.js';
import type { FilterField } from '../filter/types.js';
import { useT } from './i18n.js';

/** One document collection a reader can search: a dataset the service may use. */
export interface CorpusOption {
  /** What the platform calls it: `dataset-config-key`. */
  key: string;
  /** What the reader sees, «Kudos». A sentence uses the part before a comma, so a label may
   * carry a count of its own: «Kudos, 938 dokumenter». */
  label: string;
  /** What is in it, in the dataset's own words. */
  description?: string | undefined;
}

/** What a sentence calls a collection: its label up to the first comma. Undefined when there is
 * no label; the blocks then say «standardsamlingen». */
export const corpusName = (corpus: CorpusOption | undefined) => {
  const name = corpus?.label.split(',')[0]?.trim();
  return name === '' ? undefined : name;
};

/** Types named before «med flere». One over is named too: «med flere» would say less. */
const MAX_TYPES = 5;

export interface CorpusLineProps {
  /** The collection searched, when one is known. */
  corpus?: CorpusOption | undefined;
  /** The fields with their facets, unnarrowed, so ticking a box cannot shrink the collection.
   * Undefined while they load. */
  fields?: readonly FilterField[] | undefined;
  /** The field holding the document type; its values are counted and named, biggest first. */
  typeField?: string | undefined;
  /** What many of a type are called, by its label: «Årsrapport» is «årsrapporter». A type
   * without one is its label in lower case. */
  typePlurals?: Readonly<Record<string, string>> | undefined;
  className?: string | undefined;
}

/** The line in two parts: `source` stays on screen, `detail` is behind «Vis mer». */
export const useCorpusText = ({
  corpus,
  fields,
  typeField,
  typePlurals,
}: Pick<CorpusLineProps, 'corpus' | 'fields' | 'typeField' | 'typePlurals'>) => {
  const t = useT();
  const f = useFormat();
  const types = fields?.find((field) => field.id === typeField);
  const years = fields?.find((field) => field.kind === 'year');

  // Summed over one field, as every document has one type and one year (the type is likelier
  // complete). Undefined when any count is missing: a partial sum is wrong.
  const total = [types, years]
    .filter((field) => field !== undefined && field.options.length > 0)
    .find((field) => field?.options.every((option) => option.count !== undefined))
    ?.options.reduce((sum, option) => sum + (option.count ?? 0), 0);

  // Biggest first, so the cut keeps the types that make up the collection.
  const ordered = [...(types?.options ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const truncated = ordered.length > MAX_TYPES + 1;
  const named = (truncated ? ordered.slice(0, MAX_TYPES) : ordered).map((option) => {
    const label = option.label ?? option.value;
    return typePlurals?.[label] ?? label.toLocaleLowerCase(t.locale);
  });
  const typeText =
    named.length === 0
      ? ''
      : truncated
        ? t('corpus.andMore', { types: f.list(named) })
        : f.list(named);

  const yearValues = (years?.options ?? [])
    .map((option) => Number.parseInt(option.label ?? option.value, 10))
    .filter((year) => Number.isFinite(year));
  const first = Math.min(...yearValues);
  const last = Math.max(...yearValues);
  const yearText =
    yearValues.length === 0 ? '' : first === last ? String(first) : `${first}–${last}`;

  const clauses = (
    fields
      ? [total === undefined ? '' : t('corpus.documents', { count: total }), typeText, yearText]
      : []
  ).filter((clause) => clause !== '');

  const source = t('corpus.source', { name: corpusName(corpus) ?? t('corpus.unnamed') });
  if (clauses.length > 0) return { source, detail: clauses.join(', ') };
  // Nothing to count: the collection's own words. `source` stays, since a description may say
  // what is inside but not where it comes from.
  return { source, detail: corpus?.description };
};

/** The collection's name, with the rest behind «Vis mer»: the whole sentence wraps to two
 * lines. A button with `aria-expanded`, not `Details`, whose summary would take a line of its
 * own. The open state survives a switch: the reader is reading what just changed. */
export const CorpusLine = ({ className, ...props }: CorpusLineProps) => {
  const t = useT();
  const { source, detail } = useCorpusText(props);
  const [open, setOpen] = useState(false);
  const detailId = useId();

  return (
    <Paragraph asChild data-size="xs">
      <div className={['uib-corpus-line', className].filter(Boolean).join(' ')}>
        <span>{source}</span>

        {detail && (
          <>
            {/* `button` for `aria-expanded`; `Link` keeps it as tall as the text, where
                Designsystemet's `Button` would set the row's height. The label says what of, for
                a reader who lists the buttons out of context. */}
            <Link asChild className="uib-corpus-toggle">
              <button
                type="button"
                aria-label={open ? t('corpus.lessAbout') : t('corpus.moreAbout')}
                aria-expanded={open}
                aria-controls={detailId}
                onClick={() => setOpen((shown) => !shown)}
              >
                {open ? t('corpus.less') : t('corpus.more')}
              </button>
            </Link>

            {/* Always rendered: `aria-controls` must point at an element in the document. */}
            <span hidden={!open} id={detailId} className="uib-corpus-detail">
              {detail}
            </span>
          </>
        )}
      </div>
    </Paragraph>
  );
};

export interface CorpusChoiceProps {
  /** Every collection the service can search, in the order to offer them. Drawn only with
   * more than one. */
  options: readonly CorpusOption[];
  /** The key of the collection searched now. */
  value: string | undefined;
  /** The reader chose another. Starting a new thread for it is the host's: one thread would mix
   * citations from two collections with nothing saying which is which. */
  onChange: (key: string) => void;
  /** A filter is in force, and the host empties it on a switch, since its values belong to the
   * other collection. The announcement then says so. */
  resetsFilter?: boolean | undefined;
  className?: string | undefined;
}

/** Which collection the assistant searches. `Select`, not `Suggestion`: one value from a
 * handful. No description: the options say it. In a filter's head it speaks through the
 * filter's live region, which a switch otherwise leaves silent; alone, through its own. */
export const CorpusChoice = ({
  options,
  value,
  onChange,
  resetsFilter = false,
  className,
}: CorpusChoiceProps) => {
  const t = useT();
  const filterAnnouncer = useFilterAnnouncer();
  const [own, setOwn] = useState('');
  if (options.length < 2) return null;

  const choose = (key: string) => {
    if (key === value) return;
    const name = options.find((option) => option.key === key)?.label ?? key;
    const text = resetsFilter
      ? t('corpus.switchedReset', { name })
      : t('corpus.switched', { name });
    if (filterAnnouncer) filterAnnouncer(text);
    else setOwn((previous) => freshText(previous, text));
    onChange(key);
  };

  // The live region stands beside the field, not in it: `<output>` counts as an input, and
  // Designsystemet's field warns that it holds two.
  return (
    <>
      <Field className={['uib-corpus-choice', className].filter(Boolean).join(' ')}>
        <Label>{t('corpus.label')}</Label>
        <Select value={value ?? ''} onChange={(event) => choose(event.currentTarget.value)}>
          {options.map((option) => (
            <Select.Option key={option.key} value={option.key}>
              {option.label}
            </Select.Option>
          ))}
        </Select>
      </Field>
      {filterAnnouncer ? null : <output className="ds-sr-only">{own}</output>}
    </>
  );
};
