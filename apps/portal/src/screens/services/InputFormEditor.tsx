import {
  Alert,
  Button,
  Details,
  ErrorSummary,
  Field,
  Heading,
  Label,
  Link,
  Paragraph,
  Radio,
  Select,
  Skeleton,
  Switch,
  Tag,
  Textarea,
  Textfield,
} from '@digdir/designsystemet-react';
import { useState } from 'react';
import { ApiCallLink } from '../../components/ApiCall';
import { useDeveloperView } from '../../components/developer-view';
import { alwaysProvided, type FlowInputCheck } from '../../data/flow-inputs';
import {
  fieldIds,
  inputFieldId,
  inputFieldsOf,
  optionLines,
  takesOptions,
  takesOptionsFrom,
  inputFieldsFrom,
  type InputFormField,
  type InputKind,
} from '../../data/input-form';
import type { InputFieldSpec } from '../../data/service-definition';
import { useEditBuffer } from '../../edit-buffer';
import { useAsync } from '../../hooks';
import { useT, type PlainKey, type T } from '../../i18n';
import './input-form.css';

export interface DatasetFacets {
  ref: string;
  name: string;
  facets: string[];
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface InputOptionLookup {
  datasets: (signal: AbortSignal) => Promise<DatasetFacets[]>;
  values: (dataset: string, facet: string, signal: AbortSignal) => Promise<FacetValue[]>;
}

interface Props {
  fields: InputFormField[];
  datasets: string[];
  onChange: (fields: InputFormField[]) => void;
  lockedIds?: string[];
  flowCheck?: FlowInputCheck | undefined;
  lookup?: InputOptionLookup | undefined;
  serviceId?: string | undefined;
  tenant?: string | undefined;
}

export const validId = /^[a-z][a-zA-Z0-9_]{0,63}$/;

const reservedIds = [...alwaysProvided, 'messages', 'conversation_id', 'overrides', 'input'];

const kinds: [InputKind, PlainKey, PlainKey][] = [
  ['text', 'inputForm.kindText', 'inputForm.kindTextDesc'],
  ['long-text', 'inputForm.kindLongText', 'inputForm.kindLongTextDesc'],
  ['choice', 'inputForm.kindChoice', 'inputForm.kindChoiceDesc'],
  ['multi-choice', 'inputForm.kindMultiChoice', 'inputForm.kindMultiChoiceDesc'],
  ['year', 'inputForm.kindYear', 'inputForm.kindYearDesc'],
  ['organisation', 'inputForm.kindOrganisation', 'inputForm.kindOrganisationDesc'],
  ['number', 'inputForm.kindNumber', 'inputForm.kindNumberDesc'],
  ['date', 'inputForm.kindDate', 'inputForm.kindDateDesc'],
];

const kindLabel = (t: T, kind: InputKind) => {
  const found = kinds.find((k) => k[0] === kind);
  return found ? t(found[1]) : kind;
};

const datasetMatches = (known: DatasetFacets, ref: string) =>
  known.ref === ref || known.ref.endsWith(`/${ref}`) || known.name === ref;

export interface FormIssue {
  field: number | null;
  key: 'id' | 'options' | 'facet' | 'flow';
  text: string;
}

export const formIssues = (
  t: T,
  fields: InputFormField[],
  catalog: DatasetFacets[] | undefined,
  flowCheck?: FlowInputCheck,
): FormIssue[] => {
  const ids = fieldIds(fields);
  const out: FormIssue[] = [];
  fields.forEach((f, i) => {
    const id = ids[i] ?? '';
    const name = f.label || id;
    const first = ids.indexOf(id);
    if (!validId.test(id))
      out.push({
        field: i,
        key: 'id',
        text: t('inputForm.idFormat', { name }),
      });
    else if (first !== i)
      out.push({
        field: i,
        key: 'id',
        text: t('inputForm.idTaken', { id, field: fields[first]?.label ?? id }),
      });
    else if (reservedIds.includes(id))
      out.push({ field: i, key: 'id', text: t('inputForm.idReserved', { id }) });
    if (takesOptionsFrom(f.kind) && f.optionsFrom) {
      const from = f.optionsFrom;
      const known = catalog?.find((d) => datasetMatches(d, from.dataset));
      if (known && known.facets.length === 0)
        out.push({
          field: i,
          key: 'facet',
          text: t('inputForm.facetNoSearch', { name }),
        });
      else if (!from.facet.trim())
        out.push({ field: i, key: 'facet', text: t('inputForm.facetMissing', { name }) });
    } else if (
      (f.kind === 'choice' || f.kind === 'multi-choice') &&
      optionLines(f.options).length === 0
    )
      out.push({ field: i, key: 'options', text: t('inputForm.optionsMissing', { name }) });
  });
  for (const key of flowCheck?.missing ?? [])
    out.push({
      field: null,
      key: 'flow',
      text: t('inputForm.flowMissing', { key }),
    });
  return out;
};

const schemaOf = (fields: InputFormField[]) => {
  const ids = fieldIds(fields);
  const property = (f: InputFormField) => {
    const about = {
      title: f.label,
      ...(f.help ? { description: f.help } : {}),
      ...(f.default ? { default: f.default } : {}),
    };
    const options = !f.optionsFrom && takesOptions(f.kind) ? optionLines(f.options) : [];
    const values = options.length ? { enum: options } : {};
    if (f.kind === 'multi-choice')
      return { ...about, type: 'array', items: { type: 'string', ...values } };
    if (f.kind === 'year') return { ...about, type: 'integer' };
    if (f.kind === 'number') return { ...about, type: 'number' };
    if (f.kind === 'date') return { ...about, type: 'string', format: 'date' };
    return { ...about, type: 'string', ...values };
  };
  return JSON.stringify(
    {
      type: 'object',
      properties: {
        ...Object.fromEntries(fields.map((f, i) => [ids[i], property(f)])),
        query: { type: 'string', description: 'An optional free-text question or remark.' },
      },
      required: fields.flatMap((f, i) => (f.required ? [ids[i]] : [])),
    },
    null,
    2,
  );
};

const newField = (t: T): InputFormField => ({
  id: '',
  label: t('inputForm.newField'),
  kind: 'text',
  required: false,
  help: '',
  options: '',
  optionsFrom: null,
});

const shownValues = (t: T, values: FacetValue[]) => [
  ...values.slice(0, 4).map((v) => t('inputForm.valueCount', { value: v.value, count: v.count })),
  ...(values.length > 4 ? [t('inputForm.andMore', { count: values.length - 4 })] : []),
];

const FacetValues = ({
  lookup,
  dataset,
  facet,
}: {
  lookup: InputOptionLookup;
  dataset: string;
  facet: string;
}) => {
  const t = useT();
  const [values] = useAsync(
    (signal) => lookup.values(dataset, facet, signal),
    [lookup, dataset, facet],
  );
  if (values.status === 'loading')
    return (
      <div aria-busy="true" aria-label={t('inputForm.loadingValues')} className="stack-xs">
        <Skeleton variant="text" width="70%" />
        <Skeleton variant="text" width="55%" />
        <Skeleton variant="text" width="62%" />
      </div>
    );
  if (values.status === 'error' || values.data.length === 0) return null;
  return (
    <div className="stack-xs">
      <span className="ds-label" data-size="sm">
        {t('inputForm.valuesNow')}
      </span>
      <ul className="if-values">
        {shownValues(t, values.data).map((v) => (
          <li key={v}>{v}</li>
        ))}
      </ul>
    </div>
  );
};

const Preview = ({ fields, serviceId }: { fields: InputFormField[]; serviceId?: string }) => {
  const t = useT();
  const ids = fieldIds(fields);
  return (
    <aside aria-labelledby="fv-h" className="if-preview">
      <div className="if-editor-head">
        <Heading level={2} data-size="2xs" id="fv-h">
          {t('inputForm.previewHeading')}
        </Heading>
        {serviceId ? (
          <Button asChild variant="secondary" data-size="sm">
            <a href={`#/services/${encodeURIComponent(serviceId)}/test`}>{t('inputForm.tryIt')}</a>
          </Button>
        ) : null}
      </div>
      <div className="if-preview-form">
        {fields.length === 0 ? (
          <Field>
            <Label htmlFor="pv-chat">{t('inputForm.writeToService')}</Label>
            <Textarea id="pv-chat" rows={2} disabled />
          </Field>
        ) : null}
        {fields.map((f, i) => {
          const pid = `pv-${i}`;
          const parent = f.dependsOn ? fields[ids.indexOf(f.dependsOn)] : undefined;
          const searchable =
            f.kind === 'organisation' ||
            f.kind === 'multi-choice' ||
            (f.kind === 'choice' && !!f.optionsFrom);
          const fixed = f.kind === 'year' ? [] : optionLines(f.options);
          return (
            <Field key={pid}>
              <Label htmlFor={pid}>
                {f.label}
                {f.required ? null : (
                  <span className="if-optional"> {t('inputForm.optionalParen')}</span>
                )}
              </Label>
              {f.help ? <Field.Description>{f.help}</Field.Description> : null}
              {searchable ? (
                <input
                  className="ds-input"
                  id={pid}
                  type="search"
                  placeholder={
                    parent
                      ? t('inputForm.pickParentFirst', { parent: parent.label.toLowerCase() })
                      : t('inputForm.searchAndPick')
                  }
                  disabled={!!parent}
                />
              ) : f.kind === 'choice' || (f.kind === 'year' && f.optionsFrom) ? (
                <Select id={pid}>
                  <Select.Option value="">{t('inputForm.pick')}</Select.Option>
                  {fixed.map((o) => (
                    <Select.Option key={o} value={o}>
                      {o}
                    </Select.Option>
                  ))}
                </Select>
              ) : f.kind === 'long-text' ? (
                <Textarea id={pid} rows={3} />
              ) : (
                <input
                  className="ds-input"
                  id={pid}
                  {...(f.kind === 'date' ? { type: 'date' } : {})}
                  {...(f.kind === 'number' ? { type: 'number' } : {})}
                  {...(f.kind === 'year' ? { inputMode: 'numeric' as const } : {})}
                />
              )}
            </Field>
          );
        })}
        <Field>
          <Label htmlFor="pv-mer">
            {t('inputForm.moreToKnow')}{' '}
            <span className="if-optional">{t('inputForm.optionalParen')}</span>
          </Label>
          <Textarea id="pv-mer" rows={2} />
        </Field>
        <Button variant="primary" className="align-start" type="button">
          {t('inputForm.send')}
        </Button>
      </div>
    </aside>
  );
};

export const InputFormEditor = ({
  fields,
  datasets,
  onChange,
  lockedIds = [],
  flowCheck,
  lookup,
  serviceId,
  tenant,
}: Props) => {
  const t = useT();
  const developer = useDeveloperView();
  const [selected, setSelected] = useState<number | null>(fields.length > 0 ? 0 : null);
  const [flash, setFlash] = useState('');
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [catalogState] = useAsync(
    async (signal) => (lookup ? lookup.datasets(signal) : undefined),
    [lookup],
  );
  const catalog = catalogState.status === 'ready' ? catalogState.data : undefined;
  const ids = fieldIds(fields);
  const issues = formIssues(t, fields, catalog, flowCheck);
  const current = selected !== null && selected < fields.length ? selected : null;

  const update = (i: number, patch: Partial<InputFormField>) =>
    onChange(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    const [moved] = next.splice(i, 1);
    if (!moved) return;
    next.splice(j, 0, moved);
    onChange(next);
    setSelected(j);
    setFlash(
      t(by < 0 ? 'inputForm.movedUp' : 'inputForm.movedDown', {
        label: moved.label,
        position: j + 1,
      }),
    );
  };
  const add = () => {
    onChange([...fields, newField(t)]);
    setSelected(fields.length);
    setFlash('');
  };
  const nameOf = (ref: string) => catalog?.find((d) => datasetMatches(d, ref))?.name ?? ref;

  const flowLabel = flowCheck?.name
    ? t('inputForm.quoted', { text: flowCheck.name })
    : (flowCheck?.flow ?? '');
  const proposed = (flowCheck?.missing ?? []).filter((k) => !dismissed.includes(k));

  const editor = (() => {
    if (current === null) return null;
    const i = current;
    const f = fields[i] as InputFormField;
    const id = ids[i] ?? '';
    const locked = lockedIds.includes(id);
    const idIssue = issues.find((x) => x.field === i && x.key === 'id');
    const optionIssue = issues.find((x) => x.field === i && x.key === 'options');
    const facetIssue = issues.find((x) => x.field === i && x.key === 'facet');
    const from = f.optionsFrom;
    const known = from ? catalog?.find((d) => datasetMatches(d, from.dataset)) : undefined;
    const noFacets = !!known && known.facets.length === 0;
    const earlier = fields
      .slice(0, i)
      .map((g, j) => ({ id: ids[j] ?? '', label: g.label, kind: g.kind }))
      .filter((g) => takesOptions(g.kind));
    const parent = f.dependsOn ? earlier.find((g) => g.id === f.dependsOn) : undefined;
    const pickSource = (source: 'fixed' | 'dataset') => {
      if (source === 'fixed') return update(i, { optionsFrom: null });
      const dataset = datasets[0] ?? '';
      const facet = catalog?.find((d) => datasetMatches(d, dataset))?.facets[0] ?? '';
      update(i, { optionsFrom: { dataset, facet } });
    };
    return (
      <div id="feltredigering" className="if-editor">
        <div className="if-editor-head">
          <Heading level={3} data-size="xs">
            {t('inputForm.edit', { label: f.label })}
          </Heading>
          <Button
            variant="tertiary"
            data-size="sm"
            data-color="danger"
            onClick={() => {
              onChange(fields.filter((_x, j) => j !== i));
              setSelected(null);
              setFlash(t('inputForm.removedFromDraft', { label: f.label }));
            }}
          >
            {t('inputForm.removeField')}
          </Button>
        </div>
        <div className="if-grid">
          <Textfield
            label={t('inputForm.label')}
            value={f.label}
            onChange={(e) => {
              const label = e.target.value;
              const follows = !locked && (!f.id || f.id === inputFieldId(f.label, []));
              update(i, follows ? { label, id: '' } : { label });
            }}
          />
          <Textfield
            label={t('inputForm.id')}
            description={locked ? t('inputForm.idPublished') : t('inputForm.idHelp', { id })}
            value={id}
            readOnly={locked}
            {...(idIssue ? { error: idIssue.text } : {})}
            onChange={(e) => update(i, { id: e.target.value.trim() })}
          />
        </div>
        <Textfield
          label={t('inputForm.help')}
          value={f.help}
          onChange={(e) => update(i, { help: e.target.value })}
        />
        <div className="if-inline">
          <Switch
            label={t('inputForm.required')}
            checked={f.required}
            onChange={() => update(i, { required: !f.required })}
          />
          <Textfield
            label={t('inputForm.default')}
            {...(f.kind === 'multi-choice' ? { description: t('inputForm.defaultMulti') } : {})}
            value={f.default ?? ''}
            onChange={(e) => update(i, { default: e.target.value })}
          />
        </div>
        <fieldset className="plain-fieldset">
          <legend className="ds-label">{t('inputForm.type')}</legend>
          <div className="if-types">
            {kinds.map(([kind, label, desc]) => (
              <div key={kind} className={f.kind === kind ? 'if-type picked' : 'if-type'}>
                <Radio
                  name={`felt-type-${i}`}
                  label={t(label)}
                  description={t(desc)}
                  checked={f.kind === kind}
                  onChange={() =>
                    update(i, {
                      kind,
                      ...(takesOptionsFrom(kind) ? {} : { optionsFrom: null, dependsOn: '' }),
                    })
                  }
                />
              </div>
            ))}
          </div>
        </fieldset>
        {takesOptionsFrom(f.kind) ? (
          <>
            <fieldset className="plain-fieldset stack-xs">
              <legend className="ds-label">{t('inputForm.optionsFrom')}</legend>
              <Radio
                name={`felt-kilde-${i}`}
                label={
                  f.kind === 'year'
                    ? t('inputForm.sourceYear')
                    : f.kind === 'organisation'
                      ? t('inputForm.sourceOrganisation')
                      : t('inputForm.sourceFixed')
                }
                checked={!from}
                onChange={() => pickSource('fixed')}
              />
              <Radio
                name={`felt-kilde-${i}`}
                label={t('inputForm.sourceDataset')}
                {...(datasets.length === 0
                  ? {
                      description: t('inputForm.noDatasets'),
                    }
                  : {})}
                checked={!!from}
                disabled={datasets.length === 0 && !from}
                onChange={() => pickSource('dataset')}
              />
              {f.kind === 'organisation' ? (
                <div className="row-wrap">
                  <Radio name={`felt-kilde-${i}`} label={t('inputForm.sourceRegistry')} disabled />
                  <Tag data-color="warning" data-size="sm">
                    {t('inputForm.notDecided')}
                  </Tag>
                </div>
              ) : null}
            </fieldset>
            {!from && f.kind !== 'year' ? (
              <Field>
                <Label htmlFor={`felt-faste-${i}`}>{t('inputForm.fixedOptions')}</Label>
                <Textarea
                  id={`felt-faste-${i}`}
                  rows={4}
                  value={f.options}
                  aria-invalid={optionIssue ? true : undefined}
                  onChange={(e) => update(i, { options: e.target.value })}
                />
                {optionIssue ? (
                  <p className="ds-validation-message" data-field="validation">
                    {optionIssue.text}
                  </p>
                ) : null}
              </Field>
            ) : null}
            {from ? (
              <div className="if-source">
                <div className="if-grid">
                  <Field>
                    <Label htmlFor={`felt-datasett-${i}`}>{t('inputForm.dataset')}</Label>
                    <Select
                      id={`felt-datasett-${i}`}
                      value={from.dataset}
                      onChange={(e) => {
                        const dataset = e.target.value;
                        const facet =
                          catalog?.find((d) => datasetMatches(d, dataset))?.facets[0] ?? '';
                        update(i, { optionsFrom: { dataset, facet } });
                      }}
                    >
                      {(datasets.includes(from.dataset)
                        ? datasets
                        : [from.dataset, ...datasets]
                      ).map((d) => (
                        <Select.Option key={d} value={d}>
                          {nameOf(d)}
                        </Select.Option>
                      ))}
                    </Select>
                  </Field>
                  {known && !noFacets ? (
                    <Field>
                      <Label htmlFor={`felt-fasett-${i}`}>{t('inputForm.facet')}</Label>
                      <Select
                        id={`felt-fasett-${i}`}
                        value={from.facet}
                        aria-invalid={facetIssue ? true : undefined}
                        onChange={(e) =>
                          update(i, { optionsFrom: { ...from, facet: e.target.value } })
                        }
                      >
                        {from.facet && !known.facets.includes(from.facet) ? (
                          <Select.Option value={from.facet}>{from.facet}</Select.Option>
                        ) : null}
                        {from.facet ? null : (
                          <Select.Option value="">{t('inputForm.pick')}</Select.Option>
                        )}
                        {known.facets.map((facet) => (
                          <Select.Option key={facet} value={facet}>
                            {facet}
                          </Select.Option>
                        ))}
                      </Select>
                      {facetIssue ? (
                        <p className="ds-validation-message" data-field="validation">
                          {t('inputForm.facetUnknown')}
                        </p>
                      ) : null}
                    </Field>
                  ) : (
                    <Textfield
                      label={t('inputForm.facet')}
                      value={from.facet}
                      disabled={noFacets}
                      {...(facetIssue && !noFacets ? { error: t('inputForm.facetUnknown') } : {})}
                      onChange={(e) =>
                        update(i, { optionsFrom: { ...from, facet: e.target.value } })
                      }
                    />
                  )}
                </div>
                {noFacets ? (
                  <Alert data-color="warning" data-size="sm">
                    <Paragraph data-size="sm">{t('inputForm.noSearchEngine')}</Paragraph>
                    <Link href={`#/datasets/${encodeURIComponent(known.ref)}`}>
                      {t('inputForm.seeSearchEngine', { name: known.name })}
                    </Link>
                  </Alert>
                ) : null}
                {lookup && known && !noFacets && from.facet && !f.dependsOn ? (
                  <FacetValues lookup={lookup} dataset={known.ref} facet={from.facet} />
                ) : null}
              </div>
            ) : null}
            {f.kind !== 'year' ? (
              <Field className="if-narrow">
                <Label htmlFor={`felt-avhengig-${i}`}>{t('inputForm.dependsOn')}</Label>
                <Field.Description>{t('inputForm.dependsOnHelp')}</Field.Description>
                <Select
                  id={`felt-avhengig-${i}`}
                  value={f.dependsOn ?? ''}
                  onChange={(e) => update(i, { dependsOn: e.target.value })}
                >
                  <Select.Option value="">{t('inputForm.none')}</Select.Option>
                  {earlier.map((g) => (
                    <Select.Option key={g.id} value={g.id}>
                      {g.label}
                    </Select.Option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {parent ? (
              <div className="if-note">
                <span className="if-note-title">
                  {t('inputForm.linkSource')}
                  <Tag data-color="warning" data-size="sm">
                    {t('inputForm.notDecided')}
                  </Tag>
                </span>
                <span>
                  {t('inputForm.linkNote', {
                    parent: parent.label,
                    parentLower: parent.label.toLowerCase(),
                  })}
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  })();

  return (
    <div className="stack-sm">
      <div aria-live="polite">
        {flash ? (
          <Alert data-color="success" data-size="sm">
            {flash}
          </Alert>
        ) : null}
      </div>
      {issues.length > 0 ? (
        <ErrorSummary>
          <ErrorSummary.Heading>{t('inputForm.cannotPublish')}</ErrorSummary.Heading>
          <ErrorSummary.List>
            {issues.map((x) => (
              <ErrorSummary.Item key={`${x.field ?? 'flow'}-${x.key}-${x.text}`}>
                <ErrorSummary.Link
                  href={x.field === null ? '#flow-h' : '#feltredigering'}
                  onClick={() => x.field !== null && setSelected(x.field)}
                >
                  {x.text}
                </ErrorSummary.Link>
              </ErrorSummary.Item>
            ))}
          </ErrorSummary.List>
        </ErrorSummary>
      ) : null}
      {proposed.length > 0 && flowCheck ? (
        <section aria-labelledby="fs-h" className="if-proposal">
          <div className="row-wrap">
            <Heading level={2} data-size="2xs" id="fs-h">
              {t('inputForm.proposal', { count: proposed.length })}
            </Heading>
          </div>
          <Paragraph>
            {t('inputForm.proposalText', {
              flow: flowLabel,
              inputs: proposed.map((k) => `input.${k}`).join(', '),
            })}
          </Paragraph>
          <ul>
            {proposed.map((k) => (
              <li key={k}>
                <strong>
                  + {k} ({k})
                </strong>
                <span>{t('inputForm.kindText')}</span>
              </li>
            ))}
          </ul>
          <div className="row-wrap">
            <Button
              variant="primary"
              data-size="sm"
              onClick={() => {
                onChange([
                  ...fields,
                  ...proposed.map((k) => ({
                    ...newField(t),
                    id: k,
                    label: k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '),
                    required: true,
                  })),
                ]);
                setSelected(fields.length);
                setFlash(t('inputForm.added', { count: proposed.length }));
              }}
            >
              {t('inputForm.addToDraft')}
            </Button>
            <Button
              variant="secondary"
              data-size="sm"
              onClick={() => {
                setDismissed((d) => [...d, ...proposed]);
                setFlash(t('inputForm.dismissed'));
              }}
            >
              {t('inputForm.dismiss')}
            </Button>
          </div>
        </section>
      ) : null}
      <div className="if-layout">
        <section aria-labelledby="sk-h" className="if-main">
          <div className="if-intro">
            <Heading level={2} data-size="sm" id="sk-h">
              {t('inputForm.heading')}
            </Heading>
            <p className="meta">{t('inputForm.intro')}</p>
          </div>
          {fields.length === 0 ? (
            <div className="if-empty">
              <Paragraph>{t('inputForm.emptyText')}</Paragraph>
              <Button variant="primary" data-size="sm" onClick={add}>
                {t('inputForm.addField')}
              </Button>
            </div>
          ) : (
            <>
              <ol aria-label={t('inputForm.fields')} className="if-list">
                {fields.map((f, i) => {
                  const id = ids[i] ?? '';
                  const source = f.optionsFrom
                    ? t('inputForm.rowFrom', {
                        dataset: nameOf(f.optionsFrom.dataset),
                        facet: f.optionsFrom.facet ? ` (${f.optionsFrom.facet})` : '',
                      })
                    : takesOptions(f.kind)
                      ? t('inputForm.rowFixed')
                      : '';
                  return (
                    <li key={i} className={current === i ? 'if-row current' : 'if-row'}>
                      <span className="if-row-main">
                        <button
                          type="button"
                          className="if-row-label"
                          aria-current={current === i ? 'true' : undefined}
                          onClick={() => setSelected(i)}
                        >
                          {f.label || id}
                        </button>
                        <span className="meta">
                          {t('inputForm.rowKind', { kind: kindLabel(t, f.kind), id })}
                          {source}
                        </span>
                      </span>
                      <Tag data-size="sm" data-color={f.required ? 'info' : 'neutral'}>
                        {f.required ? t('inputForm.required') : t('inputForm.optional')}
                      </Tag>
                      {issues.some((x) => x.field === i) ? (
                        <Tag data-size="sm" data-color="danger">
                          {t('inputForm.error')}
                        </Tag>
                      ) : null}
                      <span className="if-row-actions">
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-disabled={i === 0 || undefined}
                          aria-label={t('inputForm.moveUpLabel', { name: f.label || id })}
                          onClick={() => move(i, -1)}
                        >
                          {t('inputForm.moveUp')}
                        </Button>
                        <Button
                          variant="tertiary"
                          data-size="sm"
                          aria-disabled={i === fields.length - 1 || undefined}
                          aria-label={t('inputForm.moveDownLabel', { name: f.label || id })}
                          onClick={() => move(i, 1)}
                        >
                          {t('inputForm.moveDown')}
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ol>
              <Button variant="secondary" data-size="sm" className="align-start" onClick={add}>
                {t('inputForm.addField')}
              </Button>
            </>
          )}
          {editor}
          {flowCheck ? (
            <section aria-labelledby="flow-h" className="if-flow">
              <Heading level={3} data-size="2xs" id="flow-h">
                {t('inputForm.flowNeeds')}
              </Heading>
              <p className="meta">{t('inputForm.flowReads', { flow: flowLabel })}</p>
              <ul>
                {flowCheck.used
                  .filter((k) => !alwaysProvided.has(k))
                  .map((k) => {
                    const at = ids.indexOf(k);
                    return (
                      <li key={k}>
                        <code>input.{k}</code>
                        <span className="if-flow-tags">
                          {at >= 0 ? (
                            <Tag data-size="sm" data-color="success">
                              {t('inputForm.filledBy', { label: fields[at]?.label ?? '' })}
                            </Tag>
                          ) : (
                            <>
                              <Tag data-size="sm" data-color="danger">
                                {t('inputForm.missing')}
                              </Tag>
                              <span className="if-warn">{t('inputForm.cannotPublishWithout')}</span>
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                <li>
                  <code>input.query</code>
                  <span className="if-flow-tags">
                    <Tag data-size="sm" data-color="neutral">
                      {t('inputForm.freeText')}
                    </Tag>
                  </span>
                </li>
              </ul>
            </section>
          ) : null}
          {developer ? (
            <Details>
              <Details.Summary>{t('inputForm.schemaSummary')}</Details.Summary>
              <Details.Content>
                <div className="stack-xs">
                  <Paragraph data-size="sm">
                    {t.rich('inputForm.schemaText', { code: (c) => <code>{c}</code> })}
                  </Paragraph>
                  <pre className="if-pre">{schemaOf(fields)}</pre>
                </div>
              </Details.Content>
            </Details>
          ) : null}
          {serviceId && tenant ? (
            <ApiCallLink
              call={{
                action: t('inputForm.saveAction'),
                method: 'PUT',
                path: `/tenants/${tenant}/services/${encodeURIComponent(serviceId)}/draft`,
                body: {
                  definition: { spec: { input: { fields: inputFieldsOf(fields, tenant) } } },
                  files: {},
                  revision: 0,
                },
                right: t('tableOutput.right'),
              }}
            />
          ) : null}
        </section>
        <Preview fields={fields} {...(serviceId ? { serviceId } : {})} />
      </div>
    </div>
  );
};

export const InputFieldsEditor = ({
  fields,
  tenant,
  onChange,
  ...rest
}: Omit<Props, 'fields' | 'onChange' | 'tenant'> & {
  fields: InputFieldSpec[];
  tenant: string;
  onChange: (fields: InputFieldSpec[] | undefined) => void;
}) => {
  const [buffer, setBuffer] = useEditBuffer(
    fields,
    (slice) => inputFieldsFrom({ fields: slice }),
    (form) => inputFieldsOf(form, tenant),
    (slice) => onChange(slice.length ? slice : undefined),
  );
  return <InputFormEditor {...rest} fields={buffer} onChange={setBuffer} tenant={tenant} />;
};
