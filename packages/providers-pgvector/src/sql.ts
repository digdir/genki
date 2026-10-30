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
    if (!all)
      ctes.push(`query as (select ${anyTermQuery(config(), params.add(input.query))} as q)`);
    const scored = (tsv: string) => (all ? '0::float8' : `ts_rank_cd(${tsv}, query.q)::float8`);
    const matching = (tsv: string) => (all ? 'true' : `${tsv} @@ query.q`);
    const withQuery = all ? '' : ' cross join query';
    if (target === 'docs') {
      const tsv = docVector(params, input.profile.fields, config);
      ctes.push(`t as (
        select first.id, ${scored(tsv)} as s
        from kn_docs d${withQuery}
        cross join lateral (
          select c.id from kn_chunks c
          where c.dataset = d.dataset and c.generation = d.generation and c.doc_id = d.id
          order by c.position limit 1
        ) first
        where d.dataset = ${dataset} and d.generation = ${active} and ${matching(tsv)} and ${where}
        order by s desc, first.id limit ${candidates})`);
    } else {
      const table = target === 'chunks' ? 'kn_chunks' : 'kn_phrases';
      const id = target === 'chunks' ? 'x.id' : 'x.chunk_id';
      ctes.push(`t as (
        select ${id} as id, max(${scored('x.tsv')}) as s
        from ${table} x ${docJoin('x')}${withQuery}
        where x.dataset = ${dataset} and x.generation = ${active} and ${matching('x.tsv')} and ${where}
        group by ${id} order by s desc, id limit ${candidates})`);
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
