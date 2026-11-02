import { clauseFits, kindsOf, type DatasetConfig, type FilterValue } from '@genai/port-knowledge';

/** SQLSTATE a read function raises when this server does not hold the generation it was asked for. */
export const notReadyCode = 'KN503';

/** The functions the reader may execute; everything else on the knowledge server is the owner's. */
export const readFunctions = [
  'kn_generation(text, text)',
  'kn_search(text, text, text, text, text, halfvec, text[], jsonb, integer, integer, integer)',
  'kn_fetch(text, text, text[])',
  'kn_range(text, text, text, integer, integer)',
  'kn_facets(text, text, text[], jsonb)',
  'kn_documents(text, text, text[], jsonb, integer, integer)',
  'kn_resolve_citation(text, text, text[])',
] as const;

/** Owner-only helpers: the checks, and one function per read that returns the statement it runs. */
export const readHelpers = [
  'kn_allowed(text)',
  'kn_attached(text, text)',
  'kn_list_sql(text)',
  'kn_text_sql(text)',
  'kn_filter_sql(jsonb, text)',
  'kn_search_sql(text, text, text, text, text, halfvec, text[], jsonb, integer, integer, integer)',
  'kn_fetch_sql(text, text, text[])',
  'kn_range_sql(text, text, text, integer, integer)',
  'kn_facets_sql(text, text, text, jsonb)',
  'kn_documents_sql(text, text, text[], jsonb, integer, integer)',
  'kn_resolve_citation_sql(text, text, text[])',
] as const;

const definer = `language plpgsql stable security definer set search_path = pg_catalog, public`;
const hitColumns = `id text, text text, doc_id text, "position" integer, metadata jsonb, title text, url text, fields jsonb, score double precision, total integer`;
const hitSelect = `c.id, c.text, c.doc_id, c.position, c.metadata, d.title, d.url, d.fields`;

/** The generation's partition is named by literals, so the planner reads that partition only. */
const docJoin = (alias: string) =>
  `'join kn_docs d on d.dataset = ' || ds || ' and d.generation = ' || g || ' and d.id = ${alias}.doc_id'`;

const createFunctions = [
  // `app.datasets` is a JSON array of the dataset ids the router allowed, set once per read transaction.
  `create or replace function kn_allowed(p_dataset text) returns void
     language plpgsql stable set search_path = pg_catalog, public as $$
     declare allowed text := nullif(current_setting('app.datasets', true), '');
     begin
       if p_dataset is null or allowed is null or not (allowed::jsonb ? p_dataset) then
         raise exception 'dataset % is not allowed', p_dataset using errcode = '42501';
       end if;
     end $$`,
  `create or replace function kn_attached(p_dataset text, p_generation text) returns void
     language plpgsql stable set search_path = pg_catalog, public as $$
     begin
       if not exists (select 1 from kn_generations
                        where generation = p_generation and dataset = p_dataset and state = 'attached') then
         raise exception 'generation % is not on this server', p_generation using errcode = '${notReadyCode}';
       end if;
     end $$`,
  // A field value as a list, whether it was stored as one value or as a list.
  `create or replace function kn_list_sql(p_json text) returns text
     language sql immutable set search_path = pg_catalog, public as $$
     select format('(case jsonb_typeof(%1$s) when ''array'' then %1$s else jsonb_build_array(%1$s) end)', p_json) $$`,
  `create or replace function kn_text_sql(p_json text) returns text
     language sql immutable set search_path = pg_catalog, public as $$
     select format('coalesce((select string_agg(e #>> ''{}'', '' '') from jsonb_array_elements(%s) e), '''')', kn_list_sql(p_json)) $$`,
  // Clauses come normalised by the engine; select, multiselect and boolean are containment on fields,
  // so the partition's jsonb_path_ops index serves them, and integer ranges use its kn_int index.
  `create or replace function kn_filter_sql(p_filters jsonb, p_config text) returns text
     language plpgsql immutable set search_path = pg_catalog, public as $$
     declare
       c jsonb; f text; json text; part text; parts text[] := '{}';
     begin
       for c in select x from jsonb_array_elements(coalesce(p_filters, '[]')) x loop
         f := c->>'field';
         json := format('d.fields -> %L', f);
         if c->>'op' in ('in', 'not') then
           select '(' || coalesce(string_agg(format('d.fields @> %L::jsonb or d.fields @> %L::jsonb',
                     jsonb_build_object(f, v), jsonb_build_object(f, jsonb_build_array(v))), ' or '), 'false') || ')'
             into part from jsonb_array_elements(c->'values') v;
           if c->>'op' = 'not' then part := 'not ' || part; end if;
         elsif c->>'op' = 'text' then
           part := format('to_tsvector(%L::regconfig, %s) @@ %L::tsquery', p_config, kn_text_sql(json),
             replace(plainto_tsquery(p_config::regconfig, c->>'terms')::text, ' & ', ' | '));
         elsif c->>'op' = 'int' then
           part := concat_ws(' and ',
             case when c ? 'gte' then format('kn_int(%s) >= %s::bigint', json, (c->>'gte')::bigint) end,
             case when c ? 'lte' then format('kn_int(%s) <= %s::bigint', json, (c->>'lte')::bigint) end);
         elsif c->>'op' = 'range' then
           part := format('exists (select 1 from jsonb_array_elements(%s) e where %s)', kn_list_sql(json),
             concat_ws(' and ',
               case jsonb_typeof(c->'gte')
                 when 'number' then format('(case when jsonb_typeof(e) = ''number'' then (e #>> ''{}'')::numeric end) >= %s::numeric', (c->>'gte')::numeric)
                 when 'string' then format('(case when jsonb_typeof(e) = ''string'' then e #>> ''{}'' end) collate "C" >= %L::text', c->>'gte') end,
               case jsonb_typeof(c->'lte')
                 when 'number' then format('(case when jsonb_typeof(e) = ''number'' then (e #>> ''{}'')::numeric end) <= %s::numeric', (c->>'lte')::numeric)
                 when 'string' then format('(case when jsonb_typeof(e) = ''string'' then e #>> ''{}'' end) collate "C" <= %L::text', c->>'lte') end));
         else
           raise exception 'unknown filter operation %', c->>'op' using errcode = '22023';
         end if;
         parts := parts || ('(' || part || ')');
       end loop;
       return coalesce(nullif(array_to_string(parts, ' and '), ''), 'true');
     end $$`,
  `create or replace function kn_search_sql(
       p_dataset text, p_generation text, p_target text, p_mode text, p_query text, p_vector halfvec,
       p_fields text[], p_filters jsonb, p_limit integer, p_candidates integer, p_rrf_k integer)
     returns text language plpgsql stable set search_path = pg_catalog, public as $$
     declare
       ds text := quote_literal(p_dataset);
       g text := quote_literal(p_generation);
       recipe jsonb;
       cfg text;
       dims integer;
       where_sql text;
       use_text boolean := p_mode <> 'vector';
       use_vector boolean := p_mode <> 'text' and p_vector is not null;
       match_all boolean := btrim(p_query) = '*';
       q text;
       tsv text;
       tbl text;
       id_col text;
       dist text;
       ctes text[] := '{}';
     begin
       if p_target not in ('chunks', 'phrases', 'docs') or p_mode not in ('text', 'vector', 'hybrid') then
         raise exception 'unknown profile %/%', p_target, p_mode using errcode = '22023';
       end if;
       select k.recipe into recipe from kn_generations k where k.generation = p_generation and k.dataset = p_dataset;
       cfg := coalesce(recipe->>'textSearchConfig', 'norwegian');
       dims := coalesce((recipe->'embedding'->>'dimensions')::integer, vector_dims(p_vector));
       where_sql := kn_filter_sql(p_filters, cfg);
       if use_text then
         if not match_all then
           q := format('%L::tsquery', replace(plainto_tsquery(cfg::regconfig, p_query)::text, ' & ', ' | '));
         end if;
         if p_target = 'docs' then
           tsv := case
             when p_fields is null then 'd.tsv'
             when p_fields = array['title'] then 'd.title_tsv'
             else format('to_tsvector(%L::regconfig, concat_ws('' '', %s))', cfg,
               (select string_agg(case when f = 'title' then 'coalesce(d.title, '''')'
                                       else kn_text_sql(format('d.fields -> %L', f)) end, ', ')
                  from unnest(p_fields) f))
           end;
           ctes := ctes || format(
             't as (select first.id, %s as s from kn_docs d
                cross join lateral (select c.id from kn_chunks c
                  where c.dataset = %s and c.generation = %s and c.doc_id = d.id order by c.position limit 1) first
                where d.dataset = %s and d.generation = %s and %s and %s
                order by s desc, first.id limit %s)',
             case when match_all then '0::float8' else format('ts_rank_cd(%s, %s)::float8', tsv, q) end,
             ds, g, ds, g,
             case when match_all then 'true' else format('%s @@ %s', tsv, q) end,
             where_sql, p_candidates);
         else
           tbl := case p_target when 'chunks' then 'kn_chunks' else 'kn_phrases' end;
           id_col := case p_target when 'chunks' then 'x.id' else 'x.chunk_id' end;
           ctes := ctes || format(
             't as (select %s as id, max(%s) as s from %s x %s
                where x.dataset = %s and x.generation = %s and %s and %s
                group by %s order by s desc, id limit %s)',
             id_col,
             case when match_all then '0::float8' else format('ts_rank_cd(x.tsv, %s)::float8', q) end,
             tbl, ${docJoin('x')}, ds, g,
             case when match_all then 'true' else format('x.tsv @@ %s', q) end,
             where_sql, id_col, p_candidates);
         end if;
       end if;
       if use_vector then
         tbl := case p_target when 'phrases' then 'kn_phrases' else 'kn_chunks' end;
         id_col := case p_target when 'phrases' then 'x.chunk_id' else 'x.id' end;
         -- The cast matches the partition's HNSW index on vec::halfvec(N).
         dist := format('x.vec::halfvec(%s) <=> %L::halfvec(%s)', dims, p_vector::text, dims);
         ctes := ctes || format(
           'v as (select id, max(s) as s from (
              select %s as id, (1 - (%s))::float8 as s from %s x %s
              where x.dataset = %s and x.generation = %s and x.vec is not null and %s
              order by %s limit %s) nearest group by id)',
           id_col, dist, tbl, ${docJoin('x')}, ds, g, where_sql, dist, p_candidates);
       end if;
       if use_text and use_vector then
         ctes := ctes || format(
           'scored as (select id, sum(1.0 / (%s::int + r))::float8 as score from (
              select id, row_number() over (order by s desc, id) as r from t
              union all
              select id, row_number() over (order by s desc, id) as r from v) u group by id)', p_rrf_k);
       else
         ctes := ctes || format('scored as (select id, s as score from %s)', case when use_text then 't' else 'v' end);
       end if;
       return format(
         'with %s
          select ${hitSelect}, sc.score, count(*) over ()::int as total
          from scored sc join kn_chunks c on c.dataset = %s and c.generation = %s and c.id = sc.id
          %s
          order by sc.score desc, c.id limit %s',
         array_to_string(ctes, E',\\n'), ds, g, ${docJoin('c')}, p_limit);
     end $$`,
  `create or replace function kn_fetch_sql(p_dataset text, p_generation text, p_ids text[]) returns text
     language plpgsql stable set search_path = pg_catalog, public as $$
     declare ds text := quote_literal(p_dataset); g text := quote_literal(p_generation);
     begin
       return format('select ${hitSelect}, null::float8, null::int from kn_chunks c %s
           where c.dataset = %s and c.generation = %s and c.id = any(%L::text[])',
         ${docJoin('c')}, ds, g, p_ids);
     end $$`,
  `create or replace function kn_range_sql(p_dataset text, p_generation text, p_document text, p_from integer, p_to integer)
     returns text language plpgsql stable set search_path = pg_catalog, public as $$
     declare ds text := quote_literal(p_dataset); g text := quote_literal(p_generation);
     begin
       return format('select ${hitSelect}, null::float8, null::int from kn_chunks c %s
           where c.dataset = %s and c.generation = %s and c.doc_id = %L and c.position between %s and %s
           order by c.position, c.id',
         ${docJoin('c')}, ds, g, p_document, p_from, p_to);
     end $$`,
  `create or replace function kn_facets_sql(p_dataset text, p_generation text, p_field text, p_filters jsonb)
     returns text language plpgsql stable set search_path = pg_catalog, public as $$
     declare
       cfg text;
     begin
       select coalesce(k.recipe->>'textSearchConfig', 'norwegian') into cfg
         from kn_generations k where k.generation = p_generation and k.dataset = p_dataset;
       return format('select %L::text, e #>> ''{}'', count(*)::int
           from kn_docs d cross join lateral jsonb_array_elements(%s) e
           where d.dataset = %L and d.generation = %L and jsonb_typeof(e) <> ''null'' and %s
           group by e #>> ''{}'' order by 3 desc, 2',
         p_field, kn_list_sql(format('d.fields -> %L', p_field)), p_dataset, p_generation,
         kn_filter_sql(p_filters, coalesce(cfg, 'norwegian')));
     end $$`,
  `create or replace function kn_documents_sql(p_dataset text, p_generation text, p_ids text[], p_filters jsonb, p_limit integer, p_offset integer)
     returns text language plpgsql stable set search_path = pg_catalog, public as $$
     declare
       ds text := quote_literal(p_dataset); g text := quote_literal(p_generation); cfg text;
     begin
       select coalesce(k.recipe->>'textSearchConfig', 'norwegian') into cfg
         from kn_generations k where k.generation = p_generation and k.dataset = p_dataset;
       return format('select d.id, d.title, d.url,
             d.fields || jsonb_build_object(''total_chunks'', (select count(*) from kn_chunks c
               where c.dataset = %s and c.generation = %s and c.doc_id = d.id)),
             count(*) over ()::int
           from kn_docs d where d.dataset = %s and d.generation = %s and %s and %s
           order by d.id limit %s offset %s',
         ds, g, ds, g,
         case when p_ids is null then 'true' else format('d.id = any(%L::text[])', p_ids) end,
         kn_filter_sql(p_filters, coalesce(cfg, 'norwegian')), p_limit, p_offset);
     end $$`,
  // Issue 139 adds earlier ids ('earlier') and tombstones ('withdrawn', with withdrawn_on) to the body only.
  `create or replace function kn_resolve_citation_sql(p_dataset text, p_generation text, p_ids text[])
     returns text language plpgsql stable set search_path = pg_catalog, public as $$
     begin
       return format('select d.id, ''found''::text, d.id, d.title, d.url, null::date from kn_docs d
           where d.dataset = %L and d.generation = %L and d.id = any(%L::text[]) order by d.id',
         p_dataset, p_generation, p_ids);
     end $$`,
  `create or replace function kn_generation(p_dataset text, p_generation text) returns jsonb ${definer} as $$
     declare v_recipe jsonb;
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       select k.recipe into v_recipe from kn_generations k where k.generation = p_generation;
       return v_recipe;
     end $$`,
  `create or replace function kn_search(
       p_dataset text, p_generation text, p_target text, p_mode text, p_query text, p_vector halfvec,
       p_fields text[], p_filters jsonb, p_limit integer, p_candidates integer, p_rrf_k integer)
     returns table (${hitColumns}) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_search_sql(p_dataset, p_generation, p_target, p_mode, p_query, p_vector,
         p_fields, p_filters, p_limit, p_candidates, p_rrf_k);
     end $$`,
  `create or replace function kn_fetch(p_dataset text, p_generation text, p_ids text[])
     returns table (${hitColumns}) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_fetch_sql(p_dataset, p_generation, p_ids);
     end $$`,
  `create or replace function kn_range(p_dataset text, p_generation text, p_document text, p_from integer, p_to integer)
     returns table (${hitColumns}) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_range_sql(p_dataset, p_generation, p_document, p_from, p_to);
     end $$`,
  `create or replace function kn_facets(p_dataset text, p_generation text, p_fields text[], p_filters jsonb)
     returns table (field text, value text, count integer) ${definer} as $$
     declare f text;
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       foreach f in array coalesce(p_fields, '{}') loop
         return query execute kn_facets_sql(p_dataset, p_generation, f, p_filters);
       end loop;
     end $$`,
  `create or replace function kn_documents(p_dataset text, p_generation text, p_ids text[], p_filters jsonb, p_limit integer, p_offset integer)
     returns table (id text, title text, url text, fields jsonb, total integer) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_documents_sql(p_dataset, p_generation, p_ids, p_filters, p_limit, p_offset);
     end $$`,
  `create or replace function kn_resolve_citation(p_dataset text, p_generation text, p_ids text[])
     returns table (cited text, status text, document text, title text, url text, withdrawn_on date) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_resolve_citation_sql(p_dataset, p_generation, p_ids);
     end $$`,
];

/** Read-function migrations for the knowledge-server list; the reader reaches data only through these. */
export const readFunctionMigrations = (reader: string): string[] => [
  ...createFunctions,
  `revoke execute on function ${[...readFunctions, ...readHelpers].join(', ')} from public`,
  `grant execute on function ${readFunctions.join(', ')} to ${reader}`,
];

export type FilterClauseRow =
  | { field: string; op: 'in' | 'not'; values: unknown[] }
  | { field: string; op: 'text'; terms: string }
  | { field: string; op: 'int'; gte?: number; lte?: number }
  | { field: string; op: 'range'; gte?: number | string; lte?: number | string };

/** Turns checked port filters into the clause rows `kn_filter_sql` builds SQL from, choosing each clause's kind as the router does. */
export const filterRows = (
  dataset: DatasetConfig,
  filters: Record<string, FilterValue> = {},
): FilterClauseRow[] =>
  Object.entries(filters).flatMap(([field, value]) => {
    const clauses =
      typeof value === 'object' && value !== null && !Array.isArray(value) && 'all' in value
        ? value.all
        : [value];
    const kinds = kindsOf(dataset.filters[field] ?? 'select');
    return clauses.map((clause): FilterClauseRow => {
      const kind = kinds.find((k) => clauseFits(k, clause)) ?? 'select';
      if (typeof clause !== 'object') {
        if (kind === 'text' && typeof clause !== 'boolean')
          return { field, op: 'text', terms: String(clause) };
        return { field, op: 'in', values: [clause] };
      }
      if (Array.isArray(clause)) return { field, op: 'in', values: clause };
      if ('not' in clause) return { field, op: 'not', values: clause.not };
      if ('contains' in clause) return { field, op: 'text', terms: clause.contains.join(' ') };
      const integer =
        dataset.valueTypes?.[field] === 'integer' &&
        [clause.gte, clause.lte].every((b) => b === undefined || typeof b === 'number');
      if (integer)
        return {
          field,
          op: 'int',
          ...(typeof clause.gte === 'number' ? { gte: Math.ceil(clause.gte) } : {}),
          ...(typeof clause.lte === 'number' ? { lte: Math.floor(clause.lte) } : {}),
        };
      return {
        field,
        op: 'range',
        ...(clause.gte === undefined ? {} : { gte: clause.gte }),
        ...(clause.lte === undefined ? {} : { lte: clause.lte }),
      };
    });
  });
