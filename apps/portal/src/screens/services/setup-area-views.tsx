import {
  Button,
  Checkbox,
  EXPERIMENTAL_Suggestion as Suggestion,
  Field,
  Heading,
  Input,
  Label,
  Paragraph,
  Select,
  Tag,
} from '@digdir/designsystemet-react';
import { SparklesIcon, XMarkIcon } from '@navikt/aksel-icons';
import { useId, useState, type ReactNode } from 'react';
import { ErrorState } from '../../states';
import { Icon } from '../../components/Icon';
import type { AsyncState } from '../../hooks';
import { useFormat } from '@genai/i18n/react';
import { useT, type Format, type PlainKey, type T } from '../../i18n';
import type { InputFieldSpec } from '../../data/service-definition';
import type { FileInput } from '../../api';
import './setup-layout.css';

export interface DatasetOption {
  id: string;
  name: string;
  shared: boolean;
  documents?: number | null;
  updatedAt?: string | null;
  owner?: { tenant: string; name: string | null };
}

/** A question the owner could ask the builder assistant; pressing it asks. */
export const AskChip = ({
  label,
  onAsk,
  off = false,
  variant = 'secondary',
}: {
  label: string;
  onAsk?: ((q: string) => void) | undefined;
  off?: boolean;
  variant?: 'secondary' | 'tertiary';
}) =>
  onAsk ? (
    <Button
      variant={variant}
      data-size="sm"
      className="ask-chip"
      aria-disabled={off || undefined}
      onClick={() => !off && onAsk(label)}
    >
      <Icon icon={SparklesIcon} size={18} />
      {label}
    </Button>
  ) : null;

const ownerLabel = (t: T, d: DatasetOption) =>
  d.shared ? t('setupList.sharedDataset') : (d.owner?.name ?? d.owner?.tenant ?? '');

export const datasetMeta = (t: T, f: Format, d: DatasetOption) => {
  const documents =
    typeof d.documents === 'number'
      ? t('setupList.documents', { count: d.documents })
      : t('setupList.documentsUnknown');
  const second = d.shared
    ? d.owner?.name
      ? t('setupList.datasetFrom', { owner: d.owner.name })
      : t('setupList.datasetFromUnknown')
    : d.updatedAt
      ? t('setupList.datasetUpdated', { date: f.date(d.updatedAt, 'long') })
      : t('setupList.datasetNeverUpdated');
  return `${documents} · ${second}`;
};

const DatasetSuggestion = ({
  chosen,
  options,
  readOnly,
  nameOf,
  onChange,
}: {
  chosen: string[];
  options: AsyncState<DatasetOption[]>;
  readOnly: boolean;
  nameOf: (id: string) => string;
  onChange: (ids: string[]) => void;
}) => {
  const t = useT();
  const id = useId();
  const list = options.status === 'ready' ? options.data : [];
  const known = new Set(list.map((d) => d.id));
  // A chosen collection the catalogue does not list is still shown, by its id.
  const items = [
    ...list.map((d) => ({ value: d.id, label: d.name })),
    ...chosen.filter((c) => !known.has(c)).map((c) => ({ value: c, label: nameOf(c) })),
  ];
  return (
    <Field>
      <Label htmlFor={id}>{t('setupList.datasetsLabel')}</Label>
      <Field.Description>{t('setupList.datasetsHelp')}</Field.Description>
      <Suggestion
        multiple
        selected={items.filter((item) => chosen.includes(item.value))}
        onSelectedChange={(picked) => {
          const ids = picked.map((item) => item.value);
          if (ids.join('\n') !== chosen.join('\n')) onChange(ids);
        }}
      >
        <Suggestion.Input id={id} readOnly={readOnly} />
        <Suggestion.Clear aria-label={t('setupList.datasetsClear')} />
        <Suggestion.List>
          <Suggestion.Empty>
            {options.status === 'loading'
              ? t('setup.loadingDatasets')
              : options.status === 'error'
                ? t('setupList.datasetsFailed')
                : t('setupList.noHits')}
          </Suggestion.Empty>
          {items.map((item) => (
            <Suggestion.Option key={item.value} value={item.value} label={item.label}>
              {item.label}
            </Suggestion.Option>
          ))}
        </Suggestion.List>
      </Suggestion>
    </Field>
  );
};

export const SourcesArea = ({
  chosen,
  options,
  addedInDraft,
  readOnly,
  onAdd,
  onRemove,
  onClear,
  ask,
  nameOf,
  onSet,
}: {
  chosen: string[];
  options: AsyncState<DatasetOption[]>;
  addedInDraft: (id: string) => boolean;
  readOnly: boolean;
  onAdd: (id: string) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  ask?: ((q: string) => void) | undefined;
  nameOf: (id: string) => string;
  /** Sets the whole list. With it, the choice is Designsystemet's Suggestion, several at once. */
  onSet?: ((ids: string[]) => void) | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const [query, setQuery] = useState('');
  if (onSet)
    return (
      <div className="stack area-stack">
        <AskChip label={t('setupList.askSources')} onAsk={ask} />
        <DatasetSuggestion
          chosen={chosen}
          options={options}
          readOnly={readOnly}
          nameOf={nameOf}
          onChange={onSet}
        />
      </div>
    );
  const needle = query.trim().toLowerCase();
  const list = options.status === 'ready' ? options.data : [];
  const hits = needle
    ? list.filter((d) => `${d.name} ${ownerLabel(t, d)}`.toLowerCase().includes(needle))
    : [];
  return (
    <div className="stack area-stack">
      <AskChip label={t('setupList.askSources')} onAsk={ask} />
      <div className="stack-xs">
        <label htmlFor="area-ds" className="area-label">
          {t('setupList.datasetsLabel')}
        </label>
        <span id="area-ds-help" className="meta area-help">
          {t('setupList.datasetsHelp')}
        </span>
        {chosen.length === 0 ? (
          <span className="area-empty">{t('setupList.datasetsNone')}</span>
        ) : null}
        <ul className="chosen-list" aria-label={t('setupList.datasetsChosen')}>
          {chosen.map((id, i) => {
            const name = nameOf(id);
            return (
              <li key={`${id}-${i}`} className="chosen-chip">
                <span className="chosen-name">{name}</span>
                {addedInDraft(id) ? (
                  <span className="chosen-badge">{t('setupList.addedInDraft')}</span>
                ) : null}
                {readOnly ? null : (
                  <button
                    type="button"
                    className="chosen-remove"
                    aria-label={t('setupList.removeDataset', { name })}
                    onClick={() => onRemove(i)}
                  >
                    <Icon icon={XMarkIcon} size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {readOnly ? null : (
          <div className="area-search-row">
            <Input
              id="area-ds"
              type="search"
              role="combobox"
              aria-expanded={!!needle}
              aria-controls="area-ds-list"
              aria-describedby="area-ds-help"
              placeholder={t('setupList.datasetsSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {chosen.length ? (
              <button type="button" className="link-button" onClick={onClear}>
                {t('setupList.datasetsClear')}
              </button>
            ) : null}
          </div>
        )}
        {needle && options.status === 'loading' ? (
          <p className="meta">{t('setup.loadingDatasets')}</p>
        ) : null}
        {needle && options.status === 'error' ? (
          <ErrorState error={options.error} headingLevel={3} />
        ) : null}
        {needle && options.status === 'ready' ? (
          <ul id="area-ds-list" aria-label={t('setupList.datasetsHits')} className="hit-list">
            {hits.map((d) => {
              const added = chosen.includes(d.id);
              return (
                <li key={d.id} className="hit-row">
                  <span className="hit-text">
                    <span className="hit-name">{d.name}</span>
                    <span className="meta">{datasetMeta(t, f, d)}</span>
                  </span>
                  <Tag data-size="sm" data-color={d.shared ? 'success' : 'neutral'}>
                    {ownerLabel(t, d)}
                  </Tag>
                  <Button
                    variant={added ? 'tertiary' : 'secondary'}
                    data-size="sm"
                    aria-disabled={added || undefined}
                    aria-label={
                      added
                        ? t('setupList.datasetAddedLabel', { name: d.name })
                        : t('setupList.datasetAddLabel', { name: d.name })
                    }
                    onClick={() => !added && onAdd(d.id)}
                  >
                    {added ? t('setup.added') : t('setupList.add')}
                  </Button>
                </li>
              );
            })}
            {hits.length === 0 ? <li className="hit-none">{t('setupList.noHits')}</li> : null}
          </ul>
        ) : null}
      </div>
    </div>
  );
};

export type { FileInput, FileLimit } from '../../api';

export const fieldKindKeys: Record<InputFieldSpec['kind'], PlainKey> = {
  text: 'setupList.fieldText',
  'long-text': 'setupList.fieldLongText',
  choice: 'setupList.fieldChoice',
  'multi-choice': 'setupList.fieldMultiChoice',
  number: 'setupList.fieldNumber',
  year: 'setupList.fieldYear',
  date: 'setupList.fieldDate',
  organisation: 'setupList.fieldOrganisation',
};

export const KindCard = ({
  name,
  description,
  checked,
  locked,
  onToggle,
}: {
  name: string;
  description: string;
  checked: boolean;
  locked?: boolean;
  onToggle: () => void;
}) => (
  <div className={checked ? 'kind-card picked' : 'kind-card'}>
    <Checkbox
      label={name}
      description={description}
      checked={checked}
      {...(locked ? { readOnly: true } : {})}
      onChange={() => !locked && onToggle()}
    />
  </div>
);

export const InputArea = ({
  fields,
  newFieldIds,
  useFields,
  useFiles,
  fileInput,
  extraKinds,
  fieldsEditor,
  readOnly,
  onFields,
  onFiles,
  ask,
}: {
  fields: InputFieldSpec[];
  newFieldIds: Set<string>;
  useFields: boolean;
  useFiles: boolean;
  fileInput: AsyncState<FileInput | undefined>;
  extraKinds?: ReactNode;
  fieldsEditor: (open: string | 'new' | undefined, close: () => void) => ReactNode;
  readOnly: boolean;
  onFields: (on: boolean) => void;
  onFiles: (on: boolean) => void;
  ask?: ((q: string) => void) | undefined;
}) => {
  const t = useT();
  const f = useFormat();
  const id = useId();
  const [editing, setEditing] = useState<string | 'new'>();
  const limit =
    fileInput.status === 'ready'
      ? (fileInput.data?.documents ?? fileInput.data?.media ?? undefined)
      : undefined;
  return (
    <div className="stack area-stack">
      <AskChip label={t('setupList.askInput')} onAsk={ask} />
      <fieldset className="plain-fieldset stack-xs">
        <legend className="area-label">{t('setupList.whatUserSends')}</legend>
        <KindCard
          name={t('setupList.kindText')}
          description={t('setupList.kindTextDesc')}
          checked
          locked
          onToggle={() => undefined}
        />
        <KindCard
          name={t('setupList.kindFields')}
          description={t('setupList.kindFieldsDesc')}
          checked={useFields}
          locked={readOnly}
          onToggle={() => onFields(!useFields)}
        />
        <KindCard
          name={t('setupList.kindFiles')}
          description={t('setupList.kindFilesDesc')}
          checked={useFiles}
          locked={readOnly}
          onToggle={() => onFiles(!useFiles)}
        />
        {extraKinds}
      </fieldset>
      {useFields ? (
        <div className="stack-xs area-block">
          <Heading level={3} data-size="xs">
            {t('setupList.fieldsHeading')}
          </Heading>
          <span className="meta area-help">{t('setupList.fieldsHelp')}</span>
          <div className="area-table-wrap">
            <table className="area-table">
              <thead>
                <tr>
                  <th scope="col">{t('setupList.colField')}</th>
                  <th scope="col">{t('setupList.colType')}</th>
                  <th scope="col">{t('setupList.colOptions')}</th>
                  <th scope="col">{t('setupList.colRequired')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('setupList.colActions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => (
                  <tr key={field.id}>
                    <td className="strong">
                      {field.label}
                      {newFieldIds.has(field.id) ? (
                        <span className="chosen-badge inline">{t('setupList.addedInDraft')}</span>
                      ) : null}
                    </td>
                    <td className="meta">{t(fieldKindKeys[field.kind])}</td>
                    <td className="meta">
                      {field.optionsFrom
                        ? t('setupList.optionsFrom')
                        : field.options?.length
                          ? field.options.join(', ')
                          : ''}
                    </td>
                    <td>{field.required ? t('setup.yes') : t('setup.no')}</td>
                    <td className="end">
                      {readOnly ? null : (
                        <button
                          type="button"
                          className="link-button"
                          aria-label={t('setupList.editFieldLabel', { name: field.label })}
                          onClick={() => setEditing(field.id)}
                        >
                          {t('setupList.edit')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {fields.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="meta">
                      {t('setupList.noFields')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {editing ? fieldsEditor(editing, () => setEditing(undefined)) : null}
          {readOnly || editing ? null : (
            <Button
              variant="secondary"
              data-size="sm"
              className="align-start"
              onClick={() => setEditing('new')}
            >
              {t('setupList.addField')}
            </Button>
          )}
        </div>
      ) : null}
      {useFiles ? (
        <div className="file-limits area-block">
          <Field>
            <Label htmlFor={`${id}-types`}>{t('setupList.fileTypes')}</Label>
            <Select id={`${id}-types`} defaultValue="text">
              <Select.Option value="text">{t('setupList.fileTypesText')}</Select.Option>
            </Select>
          </Field>
          <Field>
            <Label htmlFor={`${id}-max`}>{t('setupList.fileMax')}</Label>
            <Select id={`${id}-max`} defaultValue="limit" aria-describedby={`${id}-limits`}>
              <Select.Option value="limit">
                {limit ? f.bytes(limit.maxBytes) : t('setupList.fileLimitUnknown')}
              </Select.Option>
            </Select>
          </Field>
          <Field>
            <Label htmlFor={`${id}-count`}>{t('setupList.fileCount')}</Label>
            <Select id={`${id}-count`} defaultValue="limit" aria-describedby={`${id}-limits`}>
              <Select.Option value="limit">
                {limit
                  ? t('setupList.fileCountUpTo', { count: limit.maxCount })
                  : t('setupList.fileLimitUnknown')}
              </Select.Option>
            </Select>
          </Field>
          <Paragraph id={`${id}-limits`} data-size="sm" className="meta file-limits-note">
            {fileInput.status === 'error'
              ? t('setupList.fileLimitsFailed')
              : t('setupList.fileLimitsPlatform')}
          </Paragraph>
        </div>
      ) : null}
      <p className="meta">{t('setupList.inputLooksNote')}</p>
    </div>
  );
};

export interface AreaRow {
  key: string;
  title: string;
  text?: string | undefined;
  tag?: string | undefined;
  action?: { label: string; aria?: string; onClick: () => void } | undefined;
}

export const RowsArea = ({
  rows,
  emptyText,
  addLabel,
  editor,
  readOnly,
  editing,
  onEditing,
}: {
  rows: AreaRow[];
  emptyText?: string | undefined;
  addLabel: string;
  editor: ReactNode;
  readOnly: boolean;
  editing: boolean;
  onEditing: (on: boolean) => void;
}) => (
  <div className="stack-sm">
    {rows.length ? (
      <ul className="area-rows">
        {rows.map((row) => (
          <li key={row.key}>
            <span className="area-row-text">
              <span className="area-row-title">{row.title}</span>
              {row.text ? <span className="meta">{row.text}</span> : null}
            </span>
            {row.tag ? (
              <Tag data-size="sm" data-color="info">
                {row.tag}
              </Tag>
            ) : null}
            {row.action && !readOnly ? (
              <button
                type="button"
                className="link-button area-row-action"
                {...(row.action.aria ? { 'aria-label': row.action.aria } : {})}
                onClick={row.action.onClick}
              >
                {row.action.label}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    ) : emptyText ? (
      <Paragraph className="meta">{emptyText}</Paragraph>
    ) : null}
    {editing ? <div className="stack area-editor">{editor}</div> : null}
    {readOnly ? null : (
      <button
        type="button"
        className="link-button area-row-action area-add"
        aria-expanded={editing}
        onClick={() => onEditing(!editing)}
      >
        {addLabel}
      </button>
    )}
  </div>
);
