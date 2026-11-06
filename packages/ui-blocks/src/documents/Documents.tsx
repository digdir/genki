import {
  Button,
  EXPERIMENTAL_FileUpload as FileUpload,
  Field,
  Heading,
  Label,
  Link,
  List,
  Paragraph,
  Tag,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { CloudUpIcon, TrashIcon } from '@navikt/aksel-icons';
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { corpusName, type CorpusOption } from '../corpus/Corpus.js';
import { hasFiles } from '../dom.js';
import { useT } from '../i18n.js';
import { fileSize, limitText } from './uploadText.js';

/** A document behind the answer on screen, from the answer's `sources[]`. */
export interface DocumentItem {
  id: string;
  title: string;
  /** Where it can be read. Without one the title is text, and the row says why. */
  url?: string | undefined;
  /** What the document is, for the line under the title: its type, organisation and year. */
  about?: readonly string[] | undefined;
  /** The reader's own upload, which «Dine dokumenter» lists instead. */
  own?: boolean | undefined;
}

export interface DocumentsProps {
  /** The documents behind the answer on screen, in its order. Undefined («no answer yet») and
   * `[]` both show the sentence that says what comes here. Keep the array's identity while an
   * answer stands: a new array starts the list over. */
  documents?: readonly DocumentItem[] | undefined;
  /** The collection they come from, which names the list. */
  corpus?: CorpusOption | undefined;
  /** Under «Dokumenter»: what the collection is, such as `CorpusLine`. */
  corpusLine?: ReactNode;
  /** Rows before «Vis flere dokumenter». */
  visible?: number | undefined;
  headingLevel?: 2 | 3 | 4 | 5 | undefined;
  className?: string | undefined;
}

/** The collection's documents behind the answer, apart from `OwnDocuments`. No «Velg dokumenter»:
 * a disabled button cannot be reached by keyboard or say why. */
export const Documents = ({
  documents,
  corpus,
  corpusLine,
  visible = 5,
  headingLevel = 3,
  className,
}: DocumentsProps) => {
  const t = useT();
  const listHeadingId = useId();
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  // A new answer starts the list over. Set during render, not in an effect, so the longer list is
  // never painted.
  const [listed, setListed] = useState(documents);
  if (listed !== documents) {
    setListed(documents);
    setExpanded(false);
  }

  // Own uploads have their own section. The count and «Vis flere dokumenter» follow this array.
  const fromCorpus = (documents ?? []).filter((item) => !item.own);
  const hidden = expanded ? 0 : Math.max(fromCorpus.length - visible, 0);
  const shown = hidden === 0 ? fromCorpus : fromCorpus.slice(0, visible);

  // «Vis flere dokumenter» removes itself, so focus moves to the list (WCAG 2.4.3), whose heading
  // tells a screen reader what grew. In an effect, so the rows are in the DOM first; only the
  // button sets `expanded`, so this never fires on mount.
  useEffect(() => {
    if (expanded) listRef.current?.focus();
  }, [expanded]);

  const about = (item: DocumentItem) => {
    const properties = (item.about ?? []).filter(Boolean).join(' · ');
    if (item.url !== undefined) return properties;
    // Says why a title is not a link, or it reads as broken. After a comma, not « · »: the dots
    // list what the document is.
    return properties === ''
      ? t('documents.noLinkAlone')
      : `${properties}, ${t('documents.noLink')}`;
  };

  return (
    <section className={['uib-documents', className].filter(Boolean).join(' ')}>
      <Heading level={headingLevel} data-size="xs">
        {t('documents.title')}
      </Heading>
      {corpusLine}
      {/* The same short name as the corpus line, so the two never disagree. It also names the
          list below. */}
      <Heading
        level={Math.min(headingLevel + 1, 6) as 3 | 4 | 5 | 6}
        data-size="2xs"
        id={listHeadingId}
      >
        {t('documents.from', { name: corpusName(corpus) ?? t('corpus.unnamed') })}
      </Heading>

      {fromCorpus.length === 0 ? (
        <Paragraph data-size="sm">{t('documents.empty')}</Paragraph>
      ) : (
        <>
          {/* The documents behind the answer, the only total known here. Only while some are held
              back. */}
          {hidden > 0 && (
            <Paragraph data-size="xs" className="uib-documents-count">
              {t('documents.showing', { shown: shown.length, total: fromCorpus.length })}
            </Paragraph>
          )}

          {/* Focusable for «Vis flere dokumenter», not in the tab order. `ds-focus` rings it on
              :focus-visible only. */}
          <List.Unordered
            data-size="sm"
            aria-labelledby={listHeadingId}
            className="uib-documents-list ds-focus"
            tabIndex={-1}
            ref={listRef}
          >
            {shown.map((item) => {
              const line = about(item);
              return (
                <List.Item key={item.id}>
                  {item.url === undefined ? (
                    <Paragraph data-size="sm">{item.title}</Paragraph>
                  ) : (
                    <Link href={item.url} target="_blank" rel="noreferrer">
                      {item.title}
                      {/* In words: Designsystemet advises against an icon alone. */}
                      <span className="ds-sr-only"> {t('documents.opensInNewTab')}</span>
                    </Link>
                  )}
                  {line !== '' && (
                    <Paragraph data-size="xs" className="uib-documents-about">
                      {line}
                    </Paragraph>
                  )}
                </List.Item>
              );
            })}
          </List.Unordered>

          {/* Loads more, not navigation: a Button, tertiary. */}
          {hidden > 0 && (
            <Button
              variant="tertiary"
              data-size="sm"
              // Pinned to neutral, as kunnskapsassistenten draws it: more of the list.
              data-color="neutral"
              onClick={() => setExpanded(true)}
            >
              {t('documents.showMore')}
            </Button>
          )}
        </>
      )}
    </section>
  );
};

/** Why an upload failed: `unavailable` means there is no upload at all, not the reader's fault. */
export type UploadError = 'too-large' | 'wrong-type' | 'failed' | 'unavailable';

/** A document the reader uploaded. It belongs to the reader, not the thread. */
export interface OwnDocument {
  id: string;
  /** The file name, shown as its title. */
  name: string;
  /** The file type as a reader writes it, «PDF». */
  type: string;
  /** Bytes. */
  size: number;
  status: 'uploading' | 'ready' | 'failed';
  /** 0 to 100 while uploading. */
  progress?: number | undefined;
  /** Set only when `status` is `failed`. */
  error?: UploadError | undefined;
}

export interface OwnDocumentsProps {
  documents: readonly OwnDocument[];
  /** Uploads one file; the block waits for each before the next, as every upload writes to the
   * same list. A rejection does not stop the next file: the host shows the failure in the file's
   * row. Without it the zone is drawn switched off, «Kommer snart». */
  onUpload?: ((file: File) => unknown) | undefined;
  onRemove?: ((id: string) => void) | undefined;
  /** The file input's `accept`. */
  accept?: string | undefined;
  /** The file types taken, as a reader writes them: «PDF», «.docx». */
  types: readonly string[];
  /** The largest file taken, in bytes. */
  maxBytes: number;
  headingLevel?: 3 | 4 | 5 | 6 | undefined;
  className?: string | undefined;
}

/** The reader's own documents: a place to drop files, and what they dropped. */
export const OwnDocuments = ({
  documents,
  onUpload,
  onRemove,
  accept,
  types,
  maxBytes,
  headingLevel = 4,
  className,
}: OwnDocumentsProps) => {
  const t = useT();
  const f = useFormat();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const removeRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const focusAfterRemove = useRef<string | undefined>(undefined);
  const [refusal, setRefusal] = useState('');
  const typeList = f.list(types);
  const max = limitText(maxBytes);
  const errorText = (code: UploadError) =>
    code === 'too-large'
      ? t('documents.tooLarge', { max })
      : code === 'wrong-type'
        ? t('documents.wrongType', { types: typeList })
        : t(code === 'unavailable' ? 'documents.unavailable' : 'documents.failed');

  // What the live region says: a file taken in, there, or refused, never the percentage, which
  // would bury the status (WCAG 4.1.3). Silent on first render: restored documents are not news.
  // Set during render, not in an effect, which would draw the new row before saying it.
  const [seen, setSeen] = useState<ReadonlyMap<string, OwnDocument['status']>>();
  const [announcement, setAnnouncement] = useState('');
  const now = new Map(documents.map((item) => [item.id, item.status]));
  if (seen === undefined) setSeen(now);
  else {
    const changed = documents.find((item) => seen.get(item.id) !== item.status);
    if (changed) {
      setSeen(now);
      setAnnouncement(
        changed.status === 'uploading'
          ? t('documents.uploading', { name: changed.name })
          : changed.status === 'ready'
            ? t('documents.uploaded', { name: changed.name })
            : t('documents.notUploaded', {
                name: changed.name,
                reason: errorText(changed.error ?? 'failed'),
              }),
      );
    }
  }

  // A remove button that removes itself drops focus to `<body>` (WCAG 2.4.3). It goes to the
  // next row, else the previous, else the picker. In an effect, because that button exists only
  // once the shorter list is drawn.
  useEffect(() => {
    const target = focusAfterRemove.current;
    if (target === undefined) return;
    focusAfterRemove.current = undefined;
    const button = target === '' ? undefined : removeRefs.current.get(target);
    if (button) button.focus();
    else inputRef.current?.focus();
  }, [documents]);

  const remove = (id: string) => {
    const index = documents.findIndex((item) => item.id === id);
    const next = documents[index + 1] ?? documents[index - 1];
    focusAfterRemove.current = next?.id ?? '';
    removeRefs.current.delete(id);
    onRemove?.(id);
  };

  const choose = async (files: FileList | null) => {
    if (!files || !onUpload) return;
    const picked = Array.from(files);
    // The same file can be picked again, after a failure or a removal, and an input that still
    // holds it fires no change event the second time. Emptied first, so a failure cannot skip it.
    if (inputRef.current) inputRef.current.value = '';
    // One at a time: every upload writes to the same list, and two in flight would race. A
    // rejected upload is that file's failure, which its row shows; the next file is still tried.
    for (const file of picked) {
      try {
        await onUpload(file);
      } catch {
        // The host's list says the file failed, in its row.
      }
    }
  };

  // Switched off, the zone takes no pointer, so a file dropped on it lands on the section, and
  // the browser would open it in a new tab. The section takes the drop and says why; `dragover`
  // too, or the drop never fires. Where upload works, the file input takes the drop itself.
  const off = onUpload === undefined;
  const refuse = (event: DragEvent<HTMLElement>) => {
    if (!off || !hasFiles(event)) return;
    event.preventDefault();
    if (event.type === 'drop') setRefusal(errorText('unavailable'));
  };

  return (
    <section
      className={['uib-documents', 'uib-documents-own', className].filter(Boolean).join(' ')}
      onDragOver={refuse}
      onDrop={refuse}
    >
      <div className="uib-documents-own-heading">
        <Heading level={headingLevel} data-size="2xs">
          {t('documents.own')}
        </Heading>
        {/* «Ny» only where upload works. */}
        <Tag data-color="info" data-size="sm">
          {off ? t('documents.ownSoon') : t('documents.ownNew')}
        </Tag>
      </div>

      {/* «Velg filer» is a span: the real control is the file input laid over the zone, and a
          button would be a second, dead tab stop. Neutral when off, the colours Designsystemet's
          read-only state would give it. */}
      <Field>
        <Label>{t('documents.upload')}</Label>
        <FileUpload
          data-size="sm"
          data-color={off ? 'neutral' : undefined}
          className="uib-documents-own-zone"
        >
          <CloudUpIcon aria-hidden="true" className="uib-documents-own-icon" />
          {/* Off, it says what is coming, not what to do: a zone that asks for a drop it cannot
              take invites an action that fails. */}
          <Field.Description>
            {off
              ? t('documents.uploadSoon', { types: typeList, max })
              : t('documents.uploadHint', { types: typeList, max })}
          </Field.Description>
          {/* Off, `aria-disabled` marks «Velg filer» as part of a control that is off: text in an
              inactive control is exempt from 1.4.3, and Designsystemet dims it from it. */}
          <Button asChild variant="secondary" data-size="sm" aria-disabled={off || undefined}>
            <span>{t('documents.chooseFiles')}</span>
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            disabled={off}
            accept={accept}
            aria-describedby={listId}
            onChange={(event) => void choose(event.currentTarget.files)}
          />
        </FileUpload>
      </Field>

      {/* Muted, not red: nothing went wrong that the reader can fix. */}
      {refusal && (
        <Paragraph data-size="xs" className="uib-documents-own-refusal">
          {refusal}
        </Paragraph>
      )}

      {/* Mounted even when silent: a region that appears together with its text is not
          announced. */}
      <output className="ds-sr-only">{refusal || announcement}</output>

      {documents.length > 0 && (
        <ul className="uib-documents-own-list" id={listId}>
          {documents.map((item) => (
            <li key={item.id} className="uib-documents-own-item">
              <div className="uib-documents-own-text">
                <Paragraph data-size="sm" className="uib-documents-own-name">
                  {item.name}
                </Paragraph>
                {/* Progress as a number, not a bar: a bar takes a row. */}
                <Paragraph data-size="xs" className="uib-documents-own-meta">
                  {item.type} · {fileSize(item.size, t.locale)}
                  {item.status === 'uploading' &&
                    ` · ${t('documents.progress', { percent: Math.round(item.progress ?? 0) })}`}
                </Paragraph>
                {item.status === 'failed' && (
                  <Paragraph data-size="xs" className="uib-documents-own-error">
                    {errorText(item.error ?? 'failed')}
                  </Paragraph>
                )}
              </div>
              {/* The name is in the label, or four «Fjern» cannot be told apart. */}
              {onRemove ? (
                <Button
                  ref={(button) => {
                    if (button) removeRefs.current.set(item.id, button);
                    else removeRefs.current.delete(item.id);
                  }}
                  variant="tertiary"
                  // Pinned to neutral, as kunnskapsassistenten draws it: beside a file.
                  data-color="neutral"
                  data-size="sm"
                  aria-label={t('documents.remove', { name: item.name })}
                  onClick={() => remove(item.id)}
                >
                  <TrashIcon aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
