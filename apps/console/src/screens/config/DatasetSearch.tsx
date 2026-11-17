import {
  Alert,
  Button,
  Fieldset,
  FieldsetDescription,
  FieldsetLegend,
  Heading,
  Label,
  Paragraph,
  Select,
  Textfield,
} from '@digdir/designsystemet-react';
import { useFormat } from '@genai/i18n/react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, type ApiClient } from '../../api';
import { useT, type T } from '../../i18n';
import type { ConfigEntry, DatasetSearchAnswer, DatasetSearchHit, Problem } from '../../types';

const kinds = ['select', 'multiselect', 'text', 'range', 'boolean'] as const;
type Kind = (typeof kinds)[number];

interface Declared {
  field: string;
  kind: Kind;
  integer: boolean;
}

/** The filters a dataset declares in its catalogue entry: `filters`, and `facets` as multiselect. */
export const declaredFilters = (spec: Record<string, unknown>): Declared[] => {
  const filters = (spec.filters ?? {}) as Record<string, unknown>;
  const facets = Array.isArray(spec.facets) ? (spec.facets as unknown[]).map(String) : [];
  const types = (spec.valueTypes ?? {}) as Record<string, unknown>;
  const kindOf = (value: unknown): Kind => {
    const first: unknown = Array.isArray(value) ? value[0] : value;
    return kinds.find((k) => k === first) ?? 'select';
  };
  const fields = [
    ...Object.entries(filters).map(([field, value]) => ({ field, kind: kindOf(value) })),
    ...facets
      .filter((field) => !(field in filters))
      .map((field) => ({ field, kind: 'multiselect' as const })),
  ];
  return fields.map((f) => ({ ...f, integer: types[f.field] === 'integer' }));
};

/** What a person has typed into a dataset's search form. */
export interface SearchDraft {
  query: string;
  profile: string;
  limit: string;
  values: Record<string, string>;
}

/**
 * Drafts kept by dataset path above the catalogue list, so a reload of the list, or a newer
 * version of the entry, does not empty the form.
 */
export type SearchDrafts = Map<string, SearchDraft>;

export const useSearchDrafts = (): SearchDrafts => useRef<SearchDrafts>(new Map()).current;

const emptyDraft: SearchDraft = { query: '', profile: '', limit: '10', values: {} };

const freeField = '\u0000field';
const freeValue = '\u0000value';

const scalar = (raw: string, integer: boolean): string | number =>
  integer && /^-?\d+$/.test(raw) ? Number(raw) : raw;

const bound = (raw: string, integer: boolean): string | number =>
  integer || /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;

const filtersOf = (declared: Declared[], values: Record<string, string>) => {
  const filters: Record<string, unknown> = {};
  const read = (key: string) => (values[key] ?? '').trim();
  for (const { field, kind, integer } of declared) {
    if (kind === 'range') {
      const gte = read(`${field}.gte`);
      const lte = read(`${field}.lte`);
      if (gte || lte)
        filters[field] = {
          ...(gte ? { gte: bound(gte, integer) } : {}),
          ...(lte ? { lte: bound(lte, integer) } : {}),
        };
      continue;
    }
    const raw = read(field);
    if (!raw) continue;
    if (kind === 'boolean') filters[field] = raw === 'true';
    else if (kind === 'multiselect') {
      const list = raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => scalar(v, integer));
      filters[field] = list.length === 1 ? list[0] : list;
    } else filters[field] = scalar(raw, integer);
  }
  if (declared.length === 0 && read(freeField) && read(freeValue))
    filters[read(freeField)] = read(freeValue);
  return filters;
};

const shown = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

type Outcome =
  | { kind: 'answer'; answer: DatasetSearchAnswer }
  | { kind: 'failed'; message: string; details: string[] };

interface SearchProblem extends Problem {
  policy?: { rule?: string; ownedBy?: string };
}

const fieldPaths = ['query', 'profile', 'limit'] as const;

const failureOf = (error: unknown, t: T): Outcome & { kind: 'failed' } => {
  if (!(error instanceof ApiError))
    return { kind: 'failed', message: t('datasetSearch.failed'), details: [] };
  const problem = error.problem as SearchProblem | undefined;
  const messages = (problem?.errors ?? []).map((e) => e.message);
  switch (error.status) {
    case 504:
      return { kind: 'failed', message: t('datasetSearch.timedOut'), details: messages };
    case 422:
      return {
        kind: 'failed',
        message: t('datasetSearch.invalid'),
        details: (problem?.errors ?? []).map((e) =>
          e.path ? `${e.path}: ${e.message}` : e.message,
        ),
      };
    case 403:
      return problem?.policy
        ? {
            kind: 'failed',
            message: t('datasetSearch.blocked', {
              rule: problem.policy.rule ?? problem.title,
              owner: problem.policy.ownedBy ?? '',
            }),
            details: [],
          }
        : {
            kind: 'failed',
            message: t('datasetSearch.needsRight'),
            details: problem?.title ? [problem.title] : [],
          };
    case 429:
      return { kind: 'failed', message: t('datasetSearch.quota'), details: [] };
    case 404:
      return { kind: 'failed', message: t('datasetSearch.notFound'), details: [] };
    case 502:
      return { kind: 'failed', message: t('datasetSearch.engineFailed'), details: messages };
    default:
      return { kind: 'failed', message: t('datasetSearch.failed'), details: [] };
  }
};

const Hit = ({ hit, rank }: { hit: DatasetSearchHit; rank: number }) => {
  const t = useT();
  const f = useFormat();
  const pages =
    hit.page === undefined
      ? undefined
      : hit.pageEnd !== undefined && hit.pageEnd !== hit.page
        ? t('datasetSearch.pages', { page: hit.page, pageEnd: hit.pageEnd })
        : t('datasetSearch.page', { page: hit.page });
  const facts = [
    t('datasetSearch.score', { score: f.decimal(hit.score, 3) }),
    hit.position === undefined ? undefined : t('datasetSearch.part', { position: hit.position }),
    pages,
    hit.document && hit.title ? hit.document : undefined,
  ].filter(Boolean);
  return (
    <li className="stack-sm">
      <span className="label-strong">
        {rank}. <span>{hit.title ?? hit.document ?? t('datasetSearch.untitled')}</span>
      </span>
      <span className="meta">{facts.join(' · ')}</span>
      <Paragraph data-size="sm">{hit.text}</Paragraph>
      {Object.keys(hit.fields).length > 0 ? (
        <details>
          <summary>{t('datasetSearch.fields')}</summary>
          <pre className="sm">{JSON.stringify(hit.fields, null, 2)}</pre>
        </details>
      ) : null}
    </li>
  );
};

const Answer = ({ answer }: { answer: DatasetSearchAnswer }) => {
  const t = useT();
  const applied = Object.entries(answer.filters);
  return (
    <div className="stack-sm">
      <Paragraph data-size="sm" role="status">
        {t('datasetSearch.summary', {
          count: answer.hits.length,
          ms: answer.tookMs,
          profile: answer.profile,
        })}
        {answer.found === undefined ? '' : ` ${t('datasetSearch.found', { found: answer.found })}`}
      </Paragraph>
      <Paragraph data-size="sm" className="meta">
        {applied.length
          ? t('datasetSearch.filtersApplied', {
              filters: applied.map(([k, v]) => `${k} = ${shown(v)}`).join(', '),
            })
          : t('datasetSearch.noFilters')}
      </Paragraph>
      {answer.warning ? (
        <Alert data-color="warning" data-size="sm">
          {answer.warning}
        </Alert>
      ) : null}
      {answer.hits.length === 0 ? (
        <Alert data-color="info" data-size="sm">
          <Paragraph data-size="sm">{t('datasetSearch.noHits')}</Paragraph>
          {applied.length ? (
            <Paragraph data-size="sm">{t('datasetSearch.noHitsFiltered')}</Paragraph>
          ) : null}
        </Alert>
      ) : (
        <ol className="plain stack" aria-label={t('datasetSearch.hits')}>
          {answer.hits.map((hit, i) => (
            <Hit key={`${hit.id}-${i}`} hit={hit} rank={i + 1} />
          ))}
        </ol>
      )}
    </div>
  );
};

/** A direct search of one dataset: `base` is its path, `/operator/datasets/{id}` or `/tenants/{org}/datasets/{id}`. */
export const DatasetSearch = ({
  api,
  base,
  entry,
  drafts,
}: {
  api: ApiClient;
  base: string;
  entry: ConfigEntry;
  drafts?: SearchDrafts | undefined;
}) => {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [draft, setDraftState] = useState<SearchDraft>(() => drafts?.get(base) ?? emptyDraft);
  const [errors, setErrors] = useState<Partial<Record<(typeof fieldPaths)[number], string>>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const declared = declaredFilters(entry.spec);

  const change = (next: Partial<SearchDraft>) =>
    setDraftState((d) => {
      const merged = { ...d, ...next };
      drafts?.set(base, merged);
      return merged;
    });
  const setValue = (key: string, value: string) =>
    change({ values: { ...draft.values, [key]: value } });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const query = draft.query.trim();
    const limit = Number(draft.limit);
    const next: typeof errors = {};
    if (!query) next.query = t('datasetSearch.queryMissing');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      next.limit = t('datasetSearch.limitInvalid');
    setErrors(next);
    if (Object.keys(next).length) return;
    const filters = filtersOf(declared, draft.values);
    const profile = draft.profile.trim();
    setBusy(true);
    setOutcome(undefined);
    try {
      const answer = await api.datasetSearch(base, {
        query,
        ...(Object.keys(filters).length ? { filters } : {}),
        ...(profile ? { profile } : {}),
        limit,
      });
      setOutcome({ kind: 'answer', answer });
    } catch (error) {
      const failure = failureOf(error, tRef.current);
      const problem = error instanceof ApiError && error.status === 422 ? error.problem : undefined;
      const at: typeof errors = {};
      for (const e of problem?.errors ?? [])
        for (const path of fieldPaths) if (e.path === path) at[path] = e.message;
      setErrors(at);
      setOutcome(failure);
    } finally {
      setBusy(false);
    }
  };

  const prefix = useId();
  const id = (suffix: string) => `${prefix}-${suffix}`;

  return (
    <section className="stack-sm" aria-labelledby={id('h')}>
      <Heading level={4} data-size="2xs" id={id('h')}>
        {t('datasetSearch.title')}
      </Heading>
      <Paragraph data-size="sm" className="meta">
        {t('datasetSearch.intro')}
      </Paragraph>
      <form className="stack-sm" onSubmit={(e) => void submit(e)} noValidate>
        <Textfield
          label={t('datasetSearch.query')}
          value={draft.query}
          error={errors.query}
          onChange={(e) => change({ query: e.target.value })}
        />
        <Fieldset>
          <FieldsetLegend>{t('datasetSearch.filters')}</FieldsetLegend>
          <FieldsetDescription>
            {declared.length ? t('datasetSearch.filtersHint') : t('datasetSearch.freeHint')}
          </FieldsetDescription>
          {declared.map(({ field, kind }) =>
            kind === 'range' ? (
              <div key={field} className="toolbar">
                <Textfield
                  label={t('datasetSearch.rangeFrom', { field })}
                  value={draft.values[`${field}.gte`] ?? ''}
                  onChange={(e) => setValue(`${field}.gte`, e.target.value)}
                />
                <Textfield
                  label={t('datasetSearch.rangeTo', { field })}
                  value={draft.values[`${field}.lte`] ?? ''}
                  onChange={(e) => setValue(`${field}.lte`, e.target.value)}
                />
              </div>
            ) : kind === 'boolean' ? (
              <div key={field} className="field">
                <Label htmlFor={id(`f-${field}`)}>{field}</Label>
                <Select
                  id={id(`f-${field}`)}
                  value={draft.values[field] ?? ''}
                  onChange={(e) => setValue(field, e.target.value)}
                >
                  <Select.Option value="">{t('datasetSearch.booleanAny')}</Select.Option>
                  <Select.Option value="true">{t('datasetSearch.booleanYes')}</Select.Option>
                  <Select.Option value="false">{t('datasetSearch.booleanNo')}</Select.Option>
                </Select>
              </div>
            ) : (
              <Textfield
                key={field}
                label={field}
                {...(kind === 'multiselect'
                  ? { description: t('datasetSearch.multiselectHint') }
                  : kind === 'text'
                    ? { description: t('datasetSearch.textHint') }
                    : {})}
                value={draft.values[field] ?? ''}
                onChange={(e) => setValue(field, e.target.value)}
              />
            ),
          )}
          {declared.length === 0 ? (
            <div className="toolbar">
              <Textfield
                label={t('datasetSearch.freeField')}
                value={draft.values[freeField] ?? ''}
                onChange={(e) => setValue(freeField, e.target.value)}
              />
              <Textfield
                label={t('datasetSearch.freeValue')}
                value={draft.values[freeValue] ?? ''}
                onChange={(e) => setValue(freeValue, e.target.value)}
              />
            </div>
          ) : null}
        </Fieldset>
        <div className="toolbar">
          <Textfield
            label={t('datasetSearch.profile')}
            description={t('datasetSearch.profileHint')}
            value={draft.profile}
            error={errors.profile}
            onChange={(e) => change({ profile: e.target.value })}
          />
          <Textfield
            label={t('datasetSearch.limit')}
            type="number"
            min={1}
            max={100}
            value={draft.limit}
            error={errors.limit}
            onChange={(e) => change({ limit: e.target.value })}
          />
        </div>
        <Button type="submit" data-size="sm" className="align-start" loading={busy}>
          {t('datasetSearch.search')}
        </Button>
      </form>
      {outcome?.kind === 'failed' ? (
        <Alert data-color="danger" data-size="sm" role="alert">
          <Paragraph data-size="sm">{outcome.message}</Paragraph>
          {outcome.details.length ? (
            <ul className="plain">
              {outcome.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
      {outcome?.kind === 'answer' ? <Answer answer={outcome.answer} /> : null}
    </section>
  );
};
