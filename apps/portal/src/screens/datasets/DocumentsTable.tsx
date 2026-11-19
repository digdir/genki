import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Heading,
  Paragraph,
  Input,
  Label,
  Pagination,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  usePagination,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useState, type FormEvent } from 'react';
import type { DatasetDocument } from '../../api/datasets';
import {
  documentPageSizes,
  documentStatusColors,
  documentStatusKeys,
  type DocumentPageSize,
} from '../../data/datasets';
import { BusyButton } from '../../components/BusyButton';
import { useT, type T } from '../../i18n';
import { reasonText } from './live-model';

const text = (value: unknown) =>
  value === undefined || value === null || value === ''
    ? undefined
    : Array.isArray(value)
      ? value.join(', ')
      : String(value);

const fieldOf = (doc: Pick<DatasetDocument, 'fields'>, ...names: string[]) =>
  names.map((n) => text(doc.fields[n])).find((v) => v !== undefined);

export const typeOf = (doc: Pick<DatasetDocument, 'fields'>) => fieldOf(doc, 'type', 'doc_type');
export const yearOf = (doc: Pick<DatasetDocument, 'fields'>) => fieldOf(doc, 'year');
export const unitOf = (doc: Pick<DatasetDocument, 'fields'>) => fieldOf(doc, 'unit', 'orgs_long');

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

export const sourceOf = (t: T, doc: Pick<DatasetDocument, 'original' | 'url'>) =>
  doc.original ? t('datasets.sourceUploaded') : doc.url ? hostOf(doc.url) : undefined;

export const DocumentsTable = ({
  documents,
  openId,
  busy,
  onOpen,
  selected,
  onSelect,
}: {
  documents: DatasetDocument[];
  openId: string | undefined;
  busy: boolean;
  onOpen: (doc: DatasetDocument) => void;
  selected: ReadonlySet<string>;
  onSelect: (docs: DatasetDocument[], on: boolean) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const selectable = documents.filter((d) => d.original);
  const allOn = selectable.length > 0 && selectable.every((d) => selected.has(d.id));
  return (
    <div
      className={busy ? 'table-scroll docs-table busy' : 'table-scroll docs-table'}
      role="region"
      aria-label={t('datasets.documentsTableRegion')}
      tabIndex={0}
    >
      <Table aria-label={t('datasets.documentsTable')} aria-busy={busy || undefined}>
        <TableHead>
          <TableRow>
            {selectable.length ? (
              <TableHeaderCell scope="col" className="docs-check">
                <Checkbox
                  aria-label={t('datasets.selectAllOnPage')}
                  checked={allOn}
                  onChange={() => onSelect(selectable, !allOn)}
                />
              </TableHeaderCell>
            ) : null}
            <TableHeaderCell scope="col">{t('datasets.columnTitle')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('datasets.columnType')}</TableHeaderCell>
            <TableHeaderCell scope="col">{t('datasets.columnSource')}</TableHeaderCell>
            <TableHeaderCell scope="col" className="numeric">
              {t('datasets.columnChunks')}
            </TableHeaderCell>
            <TableHeaderCell scope="col">{t('datasets.columnStatus')}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {documents.map((doc) => {
            const sub =
              doc.status === 'failed'
                ? reasonText(t, doc.reason ?? 'failed')
                : [unitOf(doc), yearOf(doc)].filter(Boolean).join(' · ');
            return (
              <TableRow key={doc.id} className={openId === doc.id ? 'docs-row open' : 'docs-row'}>
                {selectable.length ? (
                  <TableCell className="docs-check">
                    {doc.original ? (
                      <Checkbox
                        aria-label={t('datasets.selectDocument', { title: doc.title ?? doc.id })}
                        checked={selected.has(doc.id)}
                        onChange={() => onSelect([doc], !selected.has(doc.id))}
                      />
                    ) : null}
                  </TableCell>
                ) : null}
                <TableCell>
                  <button
                    type="button"
                    className="link-button"
                    aria-haspopup="dialog"
                    aria-expanded={openId === doc.id}
                    onClick={() => onOpen(doc)}
                  >
                    {doc.title ?? doc.id}
                  </button>
                  {sub ? <span className="meta docs-sub">{sub}</span> : null}
                </TableCell>
                <TableCell>{typeOf(doc) ?? '–'}</TableCell>
                <TableCell className="meta">{sourceOf(t, doc) ?? '–'}</TableCell>
                <TableCell className="numeric">
                  {doc.chunkCount === undefined ? '–' : f.number(doc.chunkCount)}
                </TableCell>
                <TableCell>
                  <Tag data-size="sm" data-color={documentStatusColors[doc.status]}>
                    {t(documentStatusKeys[doc.status])}
                  </Tag>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
};

export const DocumentsPager = ({
  page,
  pages,
  exact,
  hasNext,
  size,
  onPage,
  onSize,
}: {
  page: number;
  pages: number;
  exact: boolean;
  hasNext: boolean;
  size: DocumentPageSize;
  onPage: (page: number) => void;
  onSize: (size: DocumentPageSize) => void;
}) => {
  const t = useT();
  const f = useFormat();
  const [jump, setJump] = useState('');
  const totalPages = exact ? Math.max(pages, 1) : hasNext ? Math.max(pages, page + 1) : page;
  const {
    pages: items,
    prevButtonProps,
    nextButtonProps,
    hasPrev,
    hasNext: hasLater,
  } = usePagination({
    currentPage: page,
    totalPages,
    showPages: 7,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = Number(jump);
    if (!Number.isInteger(wanted) || wanted < 1 || (exact && wanted > totalPages)) return;
    setJump('');
    onPage(wanted);
  };
  return (
    <div className="docs-pager">
      <Field className="docs-pager-size">
        <Label htmlFor="docs-size">{t('datasets.perPage')}</Label>
        <Select
          id="docs-size"
          width="auto"
          data-size="sm"
          value={String(size)}
          onChange={(e) => onSize(Number(e.target.value) as DocumentPageSize)}
        >
          {documentPageSizes.map((s) => (
            <Select.Option key={s} value={String(s)}>
              {s}
            </Select.Option>
          ))}
        </Select>
      </Field>
      {totalPages > 1 ? (
        <>
          <Pagination aria-label={t('datasets.pagesLabel')} data-size="sm">
            <Pagination.List>
              <Pagination.Item>
                <Pagination.Button {...prevButtonProps} onClick={() => hasPrev && onPage(page - 1)}>
                  {t('datasets.previousPage')}
                </Pagination.Button>
              </Pagination.Item>
              {items.map(({ page: n, itemKey, buttonProps }) => (
                <Pagination.Item key={itemKey}>
                  {buttonProps ? (
                    <Pagination.Button
                      {...buttonProps}
                      aria-label={t('datasets.pageNumber', { page: n })}
                      onClick={() => onPage(Number(n))}
                    >
                      {f.number(Number(n))}
                    </Pagination.Button>
                  ) : (
                    <span aria-hidden="true">…</span>
                  )}
                </Pagination.Item>
              ))}
              <Pagination.Item>
                <Pagination.Button
                  {...nextButtonProps}
                  onClick={() => hasLater && onPage(page + 1)}
                >
                  {t('datasets.nextPage')}
                </Pagination.Button>
              </Pagination.Item>
            </Pagination.List>
          </Pagination>
          <form className="docs-pager-jump" onSubmit={submit}>
            <Label htmlFor="docs-jump">{t('datasets.goToPage')}</Label>
            <Input
              id="docs-jump"
              type="number"
              data-size="sm"
              min={1}
              {...(exact ? { max: totalPages } : {})}
              value={jump}
              onChange={(e) => setJump(e.target.value)}
            />
            <span className="meta">
              {t(exact ? 'datasets.ofPages' : 'datasets.ofPagesAbout', {
                amount: f.number(exact ? totalPages : pages),
              })}
            </span>
            <Button type="submit" variant="secondary" data-size="sm">
              {t('datasets.goToPageButton')}
            </Button>
          </form>
        </>
      ) : null}
    </div>
  );
};

export const SelectionBar = ({
  count,
  canRemove,
  downloading,
  removing,
  onDownload,
  onRemove,
  onClear,
}: {
  count: number;
  canRemove: boolean;
  downloading: boolean;
  removing: boolean;
  onDownload: () => void;
  onRemove: () => void;
  onClear: () => void;
}) => {
  const t = useT();
  const f = useFormat();
  return (
    <div role="region" aria-label={t('datasets.selectedRegion')} className="docs-selection">
      <strong>{t('datasets.selectedCount', { amount: f.number(count) })}</strong>
      <BusyButton
        variant="secondary"
        data-size="sm"
        busy={downloading}
        busyLabel={t('datasets.downloadingOriginals')}
        onClick={onDownload}
      >
        {t('datasets.downloadOriginals')}
      </BusyButton>
      {canRemove ? (
        <BusyButton
          variant="secondary"
          data-color="danger"
          data-size="sm"
          busy={removing}
          busyLabel={t('datasets.removingFiles')}
          onClick={onRemove}
        >
          {t('datasets.removeFromDataset')}
        </BusyButton>
      ) : null}
      <Button variant="tertiary" data-size="sm" onClick={onClear}>
        {t('datasets.clearSelection')}
      </Button>
    </div>
  );
};

export const RemoveFilesDialog = ({
  count,
  removing,
  onKeep,
  onRemove,
}: {
  count: number;
  removing: boolean;
  onKeep: () => void;
  onRemove: () => void;
}) => {
  const t = useT();
  return (
    <Dialog
      open
      modal
      onClose={onKeep}
      aria-labelledby="remove-files-h"
      closeButton={t('common.close')}
    >
      <Heading level={2} data-size="xs" id="remove-files-h">
        {t('datasets.removeQuestion', { count })}
      </Heading>
      <Paragraph>{t('datasets.removeText')}</Paragraph>
      <div className="actions">
        <Button variant="primary" autoFocus onClick={onKeep}>
          {t('common.cancel')}
        </Button>
        <BusyButton
          variant="secondary"
          data-color="danger"
          busy={removing}
          busyLabel={t('datasets.removingFiles')}
          onClick={onRemove}
        >
          {t('datasets.removeConfirm', { count })}
        </BusyButton>
      </div>
    </Dialog>
  );
};
