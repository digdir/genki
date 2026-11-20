import { Button, Input, Tag, Textarea, ValidationMessage } from '@digdir/designsystemet-react';
import { XMarkIcon } from '@navikt/aksel-icons';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../i18n';
import './setup-layout.css';

// Oppsett parts the definition cannot hold yet; kept in memory only, never sent to the API.

interface Kept {
  pages: string[];
  documents: string[];
  wish: string;
}

const kept = new Map<string, Kept>();
const empty: Kept = { pages: [], documents: [], wish: '' };

/** What was entered for this service in this page session, kept across area switches. */
const useKept = (service: string) => {
  const [value, setValue] = useState<Kept>(() => kept.get(service) ?? empty);
  const update = (change: (current: Kept) => Kept) =>
    setValue((current) => {
      const next = change(current);
      kept.set(service, next);
      return next;
    });
  return [value, update] as const;
};

/** Forgets everything kept, for tests. */
export const forgetNotYetSaved = () => kept.clear();

/** An https address, checked with the URL parser rather than a pattern. */
const webAddress = (text: string): string | undefined => {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'https:' && url.hostname.includes('.') ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const Part = ({
  id,
  label,
  help,
  children,
}: {
  id: string;
  label: string;
  help: string;
  children: ReactNode;
}) => {
  const t = useT();
  return (
    <div className="stack-xs not-yet-saved" role="group" aria-labelledby={`${id}-label`}>
      <span className="not-yet-saved-head">
        <span id={`${id}-label`} className="area-label">
          {label}
        </span>
        <Tag data-size="sm" data-color="neutral">
          {t('setupList.comingTag')}
        </Tag>
      </span>
      <span id={`${id}-help`} className="meta area-help">
        {help}
      </span>
      {children}
    </div>
  );
};

const ChosenList = ({
  label,
  items,
  removeLabel,
  onRemove,
  readOnly,
}: {
  label: string;
  items: string[];
  removeLabel: (item: string) => string;
  onRemove: (index: number) => void;
  readOnly: boolean;
}) =>
  items.length ? (
    <ul className="chosen-list" aria-label={label}>
      {items.map((item, i) => (
        <li key={`${item}-${i}`} className="chosen-chip">
          <span className="chosen-name">{item}</span>
          {readOnly ? null : (
            <button
              type="button"
              className="chosen-remove"
              aria-label={removeLabel(item)}
              onClick={() => onRemove(i)}
            >
              <Icon icon={XMarkIcon} size={14} />
            </button>
          )}
        </li>
      ))}
    </ul>
  ) : null;

/** Web pages and own documents under Kilder, after the datasets. */
export const MoreSources = ({ service, readOnly }: { service: string; readOnly: boolean }) => {
  const t = useT();
  const id = useId();
  const [value, update] = useKept(service);
  const [address, setAddress] = useState('');
  const [invalid, setInvalid] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const addPage = () => {
    const url = webAddress(address);
    setInvalid(!url);
    if (!url) return;
    update((cur) => ({ ...cur, pages: cur.pages.includes(url) ? cur.pages : [...cur.pages, url] }));
    setAddress('');
  };
  return (
    <>
      <Part id={`${id}-web`} label={t('setupList.webPages')} help={t('setupList.webPagesHelp')}>
        <ChosenList
          label={t('setupList.webPagesChosen')}
          items={value.pages}
          removeLabel={(url) => t('setupList.webPagesRemove', { url })}
          onRemove={(i) =>
            update((cur) => ({ ...cur, pages: cur.pages.filter((_p, j) => j !== i) }))
          }
          readOnly={readOnly}
        />
        {readOnly ? null : (
          <div className="area-search-row">
            <Input
              type="url"
              placeholder="https://"
              aria-labelledby={`${id}-web-label`}
              aria-describedby={`${id}-web-help${invalid ? ` ${id}-web-error` : ''}`}
              aria-invalid={invalid || undefined}
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setInvalid(false);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                addPage();
              }}
            />
            <Button variant="secondary" data-size="sm" onClick={addPage}>
              {t('setupList.webPagesAdd')}
            </Button>
          </div>
        )}
        {invalid ? (
          <ValidationMessage id={`${id}-web-error`}>
            {t('setupList.webPagesInvalid')}
          </ValidationMessage>
        ) : null}
      </Part>
      <Part
        id={`${id}-docs`}
        label={t('setupList.ownDocuments')}
        help={t('setupList.ownDocumentsHelp')}
      >
        <ChosenList
          label={t('setupList.ownDocumentsChosen')}
          items={value.documents}
          removeLabel={(name) => t('setupList.ownDocumentsRemove', { name })}
          onRemove={(i) =>
            update((cur) => ({ ...cur, documents: cur.documents.filter((_d, j) => j !== i) }))
          }
          readOnly={readOnly}
        />
        {readOnly ? null : (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              accept=".pdf,.doc,.docx,.txt,.md"
              onChange={(e) => {
                const names = Array.from(e.target.files ?? [], (f) => f.name);
                update((cur) => ({ ...cur, documents: [...cur.documents, ...names] }));
                e.target.value = '';
              }}
            />
            <Button
              variant="secondary"
              data-size="sm"
              className="align-start"
              aria-describedby={`${id}-docs-help`}
              onClick={() => picker.current?.click()}
            >
              {t('setupList.ownDocumentsPick')}
            </Button>
          </>
        )}
      </Part>
      <p className="meta">{t('setupList.notSavedYet')}</p>
    </>
  );
};

/** The owner's own words about what the service should give, under Sluttresultat. */
export const ResultWish = ({ service, readOnly }: { service: string; readOnly: boolean }) => {
  const t = useT();
  const id = useId();
  const [value, update] = useKept(service);
  return (
    <Part id={`${id}-wish`} label={t('setupList.resultWish')} help={t('setupList.resultWishHelp')}>
      <Textarea
        rows={3}
        aria-labelledby={`${id}-wish-label`}
        aria-describedby={`${id}-wish-help ${id}-wish-note`}
        readOnly={readOnly}
        value={value.wish}
        onChange={(e) => {
          const wish = e.target.value;
          update((cur) => ({ ...cur, wish }));
        }}
      />
      <p id={`${id}-wish-note`} className="meta">
        {t('setupList.notSavedYet')}
      </p>
    </Part>
  );
};
