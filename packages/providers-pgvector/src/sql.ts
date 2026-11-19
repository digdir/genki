import {
  clauseFits,
  kindsOf,
  matchAllQuery,
  type DatasetConfig,
  type FilterClause,
  type FilterKind,
  type FilterValue,
} from '@genai/port-knowledge';

export class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export interface Profile {
  target: 'chunks' | 'phrases' | 'docs';
  mode: 'text' | 'vector' | 'hybrid';
  fields?: string[] | undefined;
}

const once = (make: () => string) => {
  let value: string | undefined;
  return () => (value ??= make());
};

export const listOf = (json: string) =>
  `(case jsonb_typeof(${json}) when 'array' then ${json} else jsonb_build_array(${json}) end)`;

const anyTermQuery = (config: string, text: string) =>
  `replace(plainto_tsquery(${config}::regconfig, ${text})::text, ' & ', ' | ')::tsquery`;

/** Every word must match; quoted words match as a phrase. */
const allTermsQuery = (config: string, text: string) =>
  `websearch_to_tsquery(${config}::regconfig, ${text})`;

/**
 * The chunk of document `<from>.doc` that best matches the query's words its matched text (`<from>.tsv`) does not hold:
 * a title's words are on its cover too, so only the other words find the page that answers.
 * With no such word, or no chunk holding one, it is the document's first chunk.
 */
export const bestChunk = (query: string, from: string, dataset: string, generation: string) =>
  `select c.id from kn_chunks c
   cross join (select nullif(string_agg(w, ' '), '') as words
     from unnest(tsvector_to_array(to_tsvector('simple', nullif(querytree(${query}), 'T')))) w
     where not w = any(tsvector_to_array(${from}.tsv))) k
   where c.dataset = ${dataset} and c.generation = ${generation} and c.doc_id = ${from}.doc
   order by coalesce(ts_rank_cd(c.tsv, replace(plainto_tsquery('simple', k.words)::text, ' & ', ' | ')::tsquery), 0) desc,
     c.position
   limit 1`;

/** The most matches a text search ranks, so a common word does not rank a whole partition. */
export const textRankCap = 5000;

const textOf = (json: string) =>
  `coalesce((select string_agg(e #>> '{}', ' ') from jsonb_array_elements(${listOf(json)}) e), '')`;

const bound = (params: Params, element: string, op: '>=' | '<=', value: number | string) =>
  typeof value === 'number'
    ? `(case when jsonb_typeof(${element}) = 'number' then ${element}::numeric end) ${op} ${params.add(value)}::numeric`
    : `(case when jsonb_typeof(${element}) = 'string' then ${element} #>> '{}' end) collate "C" ${op} ${params.add(value)}::text`;

const clauseSql = (
  params: Params,
  kind: FilterKind,
  field: string,
  clause: FilterClause,
  config: () => string,
): string => {
  const json = `d.fields -> ${params.add(field)}`;
  const containsAny = (values: unknown[]) =>
    `coalesce(${json} @> any (select jsonb_array_elements(${params.add(JSON.stringify(values))}::jsonb)), false)`;
  const contains = (terms: string[]) =>
    `to_tsvector(${config()}::regconfig, ${textOf(json)}) @@ ${anyTermQuery(config(), params.add(terms.join(' ')))}`;
  if (typeof clause === 'boolean' || (typeof clause !== 'object' && kind !== 'text'))
    return `coalesce(${json} @> ${params.add(JSON.stringify(clause))}::jsonb, false)`;
  if (typeof clause !== 'object') return contains([String(clause)]);
  if (Array.isArray(clause)) return containsAny(clause);
  if ('not' in clause) return `not ${containsAny(clause.not)}`;
  if ('contains' in clause) return contains(clause.contains);
  const bounds = [
    ...(clause.gte === undefined ? [] : [bound(params, 'e', '>=', clause.gte)]),
    ...(clause.lte === undefined ? [] : [bound(params, 'e', '<=', clause.lte)]),
  ];
  return `exists (select 1 from jsonb_array_elements(${listOf(json)}) e where ${bounds.join(' and ')})`;
};

const clausesOf = (value: FilterValue): FilterClause[] =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'all' in value
    ? value.all
    : [value];

export const filterSql = (
  params: Params,
  dataset: DatasetConfig,
  filters: Record<string, FilterValue>,
  config: () => string,
): string => {
  const parts = Object.entries(filters).flatMap(([field, value]) => {
    const kinds = kindsOf(dataset.filters[field] ?? 'select');
    return clausesOf(value).map((clause) =>
      clauseSql(
        params,
        kinds.find((k) => clauseFits(k, clause)) ?? 'select',
        field,
        clause,
        config,
      ),
    );
  });
  return parts.length > 0 ? parts.map((p) => `(${p})`).join(' and ') : 'true';
};

export interface SearchSql {
  dataset: DatasetConfig;
  profile: Profile;
  query: string;
  filters: Record<string, FilterValue>;
  limit: number;
  candidates: number;
  config: string;
  rrfK: number;
  vector?: number[] | undefined;
}

const docJoin = (alias: string) =>
  `join kn_docs d on d.dataset = ${alias}.dataset and d.generation = ${alias}.generation and d.id = ${alias}.doc_id`;

export const hitColumns = `c.id, c.text, c.doc_id, c.position, c.metadata, d.title, d.url, d.fields`;

const docVector = (params: Params, fields: string[] | undefined, config: () => string) => {
  if (fields === undefined) return 'd.tsv';
  if (fields.length === 1 && fields[0] === 'title') return 'd.title_tsv';
  const parts = fields.map((f) =>
    f === 'title' ? `coalesce(d.title, '')` : textOf(`d.fields -> ${params.add(f)}`),
  );
  return `to_tsvector(${config()}::regconfig, concat_ws(' ', ${parts.join(', ')}))`;
};

export const searchSql = (input: SearchSql) => {
  const params = new Params();
  const dataset = params.add(input.dataset.id);
  const config = once(() => params.add(input.config));
  const active = `(select generation from kn_active where dataset = ${dataset})`;
  const where = filterSql(params, input.dataset, input.filters, config);
  const candidates = params.add(input.candidates);
  const { target, mode } = input.profile;
  const ctes: string[] = [];
  const text = mode !== 'vector';
  const vector = mode !== 'text' && input.vector !== undefined;

  if (text) {
    const all = input.query.trim() === matchAllQuery;
    const tsvOf = () => docVector(params, input.profile.fields, config);
    const table = target === 'chunks' ? 'kn_chunks' : 'kn_phrases';
    const id = target === 'chunks' ? 'x.id' : 'x.chunk_id';
    const query = once(() => params.add(input.query));
    // The matches are planned uncapped, so the index finds them; then at most `textRankCap` are read.
    const ranked = (q: string) => {
      if (target === 'docs') {
        const tsv = tsvOf();
        // Documents are ranked and cut first, so a chunk is picked for at most `candidates` of them.
        return `with m as materialized (
            select d.id as doc, ${tsv} as tsv from kn_docs d
            where d.dataset = ${dataset} and d.generation = ${active} and ${tsv} @@ ${q} and ${where}),
          top as (
            select doc, tsv, ts_rank_cd(tsv, ${q})::float8 as s from (select doc, tsv from m limit ${textRankCap}) m
            order by s desc, doc limit ${candidates})
          select best.id, top.s from top
          cross join lateral (${bestChunk(allTermsQuery(config(), query()), 'top', dataset, active)}) best
          order by top.s desc, best.id`;
      }
      const docFilter =
        where === 'true'
          ? ''
          : ` and exists (select 1 from kn_docs d where d.dataset = x.dataset and d.generation = x.generation and d.id = x.doc_id and ${where})`;
      return `with m as materialized (
          select ${id} as id, x.tsv from ${table} x
          where x.dataset = ${dataset} and x.generation = ${active} and x.tsv @@ ${q}${docFilter})
        select id, max(ts_rank_cd(m.tsv, ${q}))::float8 as s from (select id, tsv from m limit ${textRankCap}) m
        group by id order by s desc, id limit ${candidates}`;
    };
    if (all && target === 'docs') {
      ctes.push(`t as (
        select first.id, 0::float8 as s
        from kn_docs d
        cross join lateral (
          select c.id from kn_chunks c
          where c.dataset = d.dataset and c.generation = d.generation and c.doc_id = d.id
          order by c.position limit 1
        ) first
        where d.dataset = ${dataset} and d.generation = ${active} and ${where}
        order by s desc, first.id limit ${candidates})`);
    } else if (all) {
      ctes.push(`t as (
        select ${id} as id, 0::float8 as s
        from ${table} x ${docJoin('x')}
        where x.dataset = ${dataset} and x.generation = ${active} and ${where}
        group by ${id} order by s desc, id limit ${candidates})`);
    } else if (mode === 'text') {
      // No vector half fills the list, so some-words matches follow the all-words ones, scored below 1.
      ctes.push(`t_all as (${ranked(allTermsQuery(config(), query()))}),
        t_any as (${ranked(anyTermQuery(config(), query()))}),
        t as (select id, s from (
          select id, 1 + s / (1 + s) as s from t_all
          union all
          select id, s / (1 + s) from t_any
          where (select count(*) from t_all) < ${candidates}
            and strpos(${allTermsQuery(config(), query())}::text, '!') = 0
            and id not in (select id from t_all)) u
          order by s desc, id limit ${candidates})`);
    } else {
      // A hybrid profile's text half keeps the all-words matches only: its vector half fills the list.
      ctes.push(`t as (${ranked(allTermsQuery(config(), query()))})`);
    }
  }
  if (vector) {
    const dims = input.dataset.embedding?.dimensions ?? input.vector?.length ?? 0;
    const table = target === 'phrases' ? 'kn_phrases' : 'kn_chunks';
    const id = target === 'phrases' ? 'x.chunk_id' : 'x.id';
    const distance = `x.vec::vector(${dims}) <=> ${params.add(JSON.stringify(input.vector))}::vector(${dims})`;
    ctes.push(`v as (
      select id, max(s) as s from (
        select ${id} as id, (1 - (${distance}))::float8 as s
        from ${table} x ${docJoin('x')}
        where x.dataset = ${dataset} and x.generation = ${active} and x.vec is not null and ${where}
        order by ${distance} limit ${candidates}
      ) nearest group by id)`);
  }
  const ranked = (cte: string) =>
    `select id, row_number() over (order by s desc, id) as r from ${cte}`;
  ctes.push(
    text && vector
      ? `scored as (
          select id, sum(1.0 / (${params.add(input.rrfK)}::int + r))::float8 as score
          from (${ranked('t')} union all ${ranked('v')}) u group by id)`
      : `scored as (select id, s as score from ${text ? 't' : 'v'})`,
  );
  const sql = `with ${ctes.join(',\n')}
    select ${hitColumns}, sc.score, count(*) over ()::int as found
    from scored sc
    join kn_chunks c on c.dataset = ${dataset} and c.generation = ${active} and c.id = sc.id
    ${docJoin('c')}
    order by sc.score desc, c.id
    limit ${params.add(input.limit)}`;
  return { sql, values: params.values, usesVectors: vector };
};

export const facetSql = (
  dataset: DatasetConfig,
  field: string,
  filters: Record<string, FilterValue>,
  config: string,
) => {
  const params = new Params();
  const id = params.add(dataset.id);
  const json = `d.fields -> ${params.add(field)}`;
  const where = filterSql(
    params,
    dataset,
    filters,
    once(() => params.add(config)),
  );
  return {
    sql: `select e #>> '{}' as value, count(*)::int as count
      from kn_docs d cross join lateral jsonb_array_elements(${listOf(json)}) e
      where d.dataset = ${id} and d.generation = (select generation from kn_active where dataset = ${id})
        and jsonb_typeof(e) <> 'null' and ${where}
      group by 1 order by 2 desc, 1`,
    values: params.values,
  };
};

export const fieldsText = (fields: Record<string, unknown>) =>
  Object.values(fields)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .join(' ');
