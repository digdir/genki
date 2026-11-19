import { XMarkIcon } from '@navikt/aksel-icons';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  Dialog,
  Heading,
  Link,
  Radio,
  Search,
  Tag,
} from '@digdir/designsystemet-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CatalogModel } from '../api/models';
import type { AsyncState } from '../hooks';
import {
  bestFitFirst,
  compareMax,
  entriesOf,
  fitsOperation,
  matchesQuery,
  pickerVisible,
  residencies,
  usable,
} from '../models';
import { ErrorState, Loading } from '../states';
import type { Residency } from '../types';
import { Icon } from './Icon';
import { ModelCompare, type CompareRow } from './ModelCompare';
import { modelBlockHref, useModelText, type ModelText } from './model-text';
import './model-picker.css';

const whereColor = (r: Residency) => (r === 'global' ? 'warning' : 'info');

const Chosen = ({
  model,
  id,
  text,
  action,
}: {
  model: CatalogModel | undefined;
  id: string;
  text: ModelText;
  action: ReactNode;
}) => (
  <div className="mp-chosen">
    <div className="mp-chosen-text">
      <div className="tag-row">
        <strong className="mp-chosen-name">{model ? text.name(model) : id}</strong>
        {model?.recommended ? (
          <Tag data-size="sm" data-color="success">
            {text.t('modelWords.recommended')}
          </Tag>
        ) : null}
        {model ? (
          <Tag data-size="sm" data-color={whereColor(model.residency)}>
            {text.dataIn(model.residency)}
          </Tag>
        ) : null}
        {model && !usable(model) ? (
          <Tag data-size="sm" data-color="warning">
            {text.reason(model)}
          </Tag>
        ) : null}
      </div>
      {model ? (
        <span className="mp-facts">
          {model.price
            ? text.t('modelPicker.facts', { by: text.byLine(model), price: text.price(model) })
            : `${text.byLine(model)} · ${text.price(model)}`}
        </span>
      ) : null}
    </div>
    {action}
  </div>
);

export const ModelPicker = ({
  models,
  value,
  onChange,
  service,
  operation = 'chat',
  readOnly = false,
  onRetry,
  triggerLabel,
  residency,
}: {
  triggerLabel?: string;
  residency?: Residency;
  models: AsyncState<CatalogModel[]>;
  value: string;
  onChange: (id: string) => void;
  service: string;
  operation?: string;
  readOnly?: boolean;
  onRetry?: () => void;
}) => {
  const text = useModelText();
  const { t } = text;
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'list' | 'compare'>('list');
  const [query, setQuery] = useState('');
  const [onlyFit, setOnlyFit] = useState(true);
  const [onlyOurs, setOnlyOurs] = useState(true);
  const [where, setWhere] = useState<Residency[]>([]);
  const [more, setMore] = useState(false);
  const [pending, setPending] = useState(value);
  const [compared, setCompared] = useState<string[]>([]);
  const searchField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open && view === 'list') searchField.current?.focus();
  }, [open, view]);

  if (models.status === 'loading')
    return (
      <Loading
        label={t('modelWords.loading')}
        shape="list"
        rows={1}
        {...(onRetry ? { onRetry } : {})}
        headingLevel={3}
      />
    );
  if (models.status === 'error')
    return <ErrorState error={models.error} headingLevel={3} {...(onRetry ? { onRetry } : {})} />;

  const all = entriesOf(models.data).sort(bestFitFirst(operation, value, residency));
  const chosen = all.find((m) => m.id === value);
  const operationName = text.use(operation).toLocaleLowerCase();
  const fits = all.filter(
    (m) =>
      (!onlyFit || fitsOperation(m, operation)) &&
      (!onlyOurs || usable(m)) &&
      (!where.length || where.includes(m.residency)) &&
      matchesQuery(m, query, (x) => [text.where(x.residency)]),
  );
  const showAll = more || query.trim() !== '';
  const shown = showAll ? fits : fits.slice(0, pickerVisible);
  const picked = compared
    .map((id) => all.find((m) => m.id === id))
    .filter((m): m is (typeof all)[number] => !!m);
  const pendingModel = all.find((m) => m.id === pending);
  const selectable = (m: CatalogModel) => usable(m) && fitsOperation(m, operation);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const openPanel = () => {
    setPending(value);
    setView('list');
    setOpen(true);
  };
  const apply = () => {
    if (pendingModel && selectable(pendingModel) && pending !== value) onChange(pending);
    close();
  };
  const reset = () => {
    setQuery('');
    setWhere([]);
    setOnlyFit(true);
    setOnlyOurs(true);
  };
  const toggleCompare = (id: string) =>
    setCompared((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const rows: CompareRow[] = [
    { label: t('modelWords.rowMaker'), cell: text.maker },
    { label: t('modelWords.rowWhere'), cell: (m) => text.where(m.residency) },
    { label: t('modelWords.rowContext'), cell: text.context },
    { label: t('modelWords.rowPrice'), cell: text.price },
    { label: t('modelWords.rowCapabilities'), cell: text.capabilities },
    {
      label: t('modelWords.rowSelectable'),
      cell: (m) =>
        selectable(m) ? t('modelWords.yes') : text.reason(m) || t('modelWords.cannotAnswer'),
    },
  ];

  return (
    <>
      {all.length === 0 ? <p className="meta">{t('modelPicker.noModels')}</p> : null}
      {value && !chosen ? (
        <Alert data-color="warning" data-size="sm">
          {t('modelPicker.notInList', { model: value })}
        </Alert>
      ) : null}
      {chosen && !usable(chosen) ? (
        <Alert data-color="warning" data-size="sm">
          {chosen.reason === 'not_allowed'
            ? t('modelPicker.notAllowedNow', { model: text.name(chosen) })
            : t('modelPicker.heldForApproval', { model: text.name(chosen) })}
          {chosen.reason === 'requires_approval' ? (
            <>
              {' '}
              <Link href={modelBlockHref(chosen.id)}>{t('modelWords.requestAccessShort')}</Link>
            </>
          ) : null}
        </Alert>
      ) : null}
      <Chosen
        model={chosen}
        id={value}
        text={text}
        action={
          readOnly ? null : (
            <button
              ref={trigger}
              type="button"
              className="mp-change"
              aria-haspopup="dialog"
              {...(triggerLabel ? { 'aria-label': t('modelPicker.change') } : {})}
              onClick={openPanel}
            >
              {triggerLabel ?? t('modelPicker.change')}
            </button>
          )
        }
      />
      {open ? (
        <Dialog
          open
          modal
          placement="right"
          closeButton={false}
          closedby="any"
          className="mp-dialog"
          aria-labelledby={headingId}
          onClose={close}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        >
          <Dialog.Block className="mp-head">
            <div className="mp-title">
              <Heading level={2} data-size="xs" id={headingId}>
                {view === 'list' ? t('modelPicker.choose') : t('modelPicker.compareTitle')}
              </Heading>
              <span className="meta">
                {t('modelPicker.context', { service, operation: operationName })}
              </span>
            </div>
            <Button
              variant="tertiary"
              data-color="neutral"
              icon
              aria-label={t('modelPicker.close')}
              onClick={close}
            >
              <Icon icon={XMarkIcon} />
            </Button>
          </Dialog.Block>
          {view === 'list' ? (
            <>
              <Dialog.Block className="mp-tools">
                <div role="search" className="mp-search">
                  <label htmlFor="mp-search" className="ds-label">
                    {t('modelPicker.search')}
                  </label>
                  <Search>
                    <Search.Input
                      id="mp-search"
                      placeholder={t('modelPicker.searchPlaceholder')}
                      value={query}
                      ref={searchField}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <Search.Clear onClick={() => setQuery('')} />
                  </Search>
                </div>
                <div role="group" aria-label={t('modelPicker.filters')} className="tag-row">
                  <Chip.Checkbox checked={onlyFit} onChange={() => setOnlyFit(!onlyFit)}>
                    {t('modelPicker.fitsOperation', { operation: operationName })}
                  </Chip.Checkbox>
                  <Chip.Checkbox checked={onlyOurs} onChange={() => setOnlyOurs(!onlyOurs)}>
                    {t('modelPicker.ours')}
                  </Chip.Checkbox>
                  {residencies.map((r) => (
                    <Chip.Checkbox
                      key={r}
                      checked={where.includes(r)}
                      onChange={() =>
                        setWhere((w) => (w.includes(r) ? w.filter((x) => x !== r) : [...w, r]))
                      }
                    >
                      {text.where(r)}
                    </Chip.Checkbox>
                  ))}
                </div>
                <span role="status" className="meta">
                  {shown.length < fits.length
                    ? t('modelPicker.fitsShowing', { count: fits.length, shown: shown.length })
                    : t('modelPicker.fits', { count: fits.length })}
                </span>
              </Dialog.Block>
              <Dialog.Block className="mp-body">
                <fieldset className="mp-list">
                  <legend className="visually-hidden">{t('modelPicker.models')}</legend>
                  {shown.map((m) => {
                    const can = selectable(m);
                    const note = text.reason(m) || (can ? '' : t('modelWords.cannotAnswer'));
                    return (
                      <div
                        key={m.id}
                        className={`mp-row${m.id === pending ? ' mp-row-picked' : ''}${can ? '' : ' mp-row-off'}`}
                      >
                        <Radio
                          name="model-picker"
                          value={m.id}
                          checked={m.id === pending}
                          disabled={!can}
                          onChange={() => setPending(m.id)}
                          label={
                            <span className="tag-row">
                              <span>{text.name(m)}</span>
                              {m.id === value ? (
                                <Tag data-size="sm" data-color="accent">
                                  {t('modelPicker.current')}
                                </Tag>
                              ) : null}
                              {m.recommended ? (
                                <Tag data-size="sm" data-color="success">
                                  {t('modelWords.recommended')}
                                </Tag>
                              ) : null}
                              {note ? (
                                <Tag data-size="sm" data-color="warning">
                                  {note}
                                </Tag>
                              ) : null}
                            </span>
                          }
                          description={
                            <span className="mp-desc">
                              <span>{text.byLine(m)}</span>
                              <span className="tag-row">
                                <Tag data-size="sm" data-color={whereColor(m.residency)}>
                                  {text.dataIn(m.residency)}
                                </Tag>
                                <Tag data-size="sm" data-color="neutral">
                                  {text.priceWithUnit(m)}
                                </Tag>
                              </span>
                            </span>
                          }
                        />
                        <div className="mp-row-side">
                          <Checkbox
                            data-size="sm"
                            label={
                              <>
                                {`${t('modelWords.compare')} `}
                                <span className="visually-hidden">{text.name(m)}</span>
                              </>
                            }
                            checked={compared.includes(m.id)}
                            disabled={!compared.includes(m.id) && compared.length >= compareMax}
                            onChange={() => toggleCompare(m.id)}
                          />
                          {m.reason === 'requires_approval' ? (
                            <Link
                              href={modelBlockHref(m.id)}
                              aria-label={t('modelWords.requestAccess', { name: text.name(m) })}
                            >
                              {t('modelWords.requestAccessShort')}
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </fieldset>
                {fits.length === 0 ? (
                  <div className="stack-sm mp-none">
                    <strong>{t('modelPicker.noneTitle')}</strong>
                    <span>{t('modelPicker.noneBody')}</span>
                    <Button variant="tertiary" data-size="sm" className="mp-start" onClick={reset}>
                      {t('modelPicker.reset')}
                    </Button>
                  </div>
                ) : null}
                {!showAll && fits.length > pickerVisible ? (
                  <Button variant="tertiary" className="mp-start" onClick={() => setMore(true)}>
                    {t('modelPicker.showMore', { count: fits.length - pickerVisible })}
                  </Button>
                ) : null}
                <p className="meta">
                  {onlyFit ? `${t('modelPicker.onlyFitting', { operation: operationName })} ` : ''}
                  <Link href="#/building-blocks/models">{t('modelPicker.seeCatalog')}</Link>
                </p>
              </Dialog.Block>
            </>
          ) : (
            <Dialog.Block className="mp-body stack-sm">
              <Button variant="tertiary" className="mp-start" onClick={() => setView('list')}>
                {t('modelPicker.backToList')}
              </Button>
              <ModelCompare models={picked} rows={rows} text={text} />
              <span className="meta">{t('modelPicker.differentRows')}</span>
            </Dialog.Block>
          )}
          <Dialog.Block className="mp-foot">
            <Button
              variant="secondary"
              aria-disabled={compared.length < 2 || view === 'compare'}
              onClick={() => compared.length >= 2 && setView('compare')}
            >
              {compared.length
                ? t('modelPicker.compareCount', { count: compared.length })
                : t('modelWords.compare')}
            </Button>
            <div className="actions">
              <Button variant="secondary" onClick={close}>
                {t('modelPicker.cancel')}
              </Button>
              <Button
                variant="primary"
                aria-disabled={pending === value || undefined}
                onClick={() => pending !== value && apply()}
              >
                {pending === value
                  ? t('modelPicker.pickAnother')
                  : t('modelPicker.apply', {
                      name: pendingModel ? text.name(pendingModel) : pending,
                    })}
              </Button>
            </div>
          </Dialog.Block>
        </Dialog>
      ) : null}
    </>
  );
};
