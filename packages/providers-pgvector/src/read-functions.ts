import {
  clauseFits,
  kindsOf,
  maxPartsAround,
  maxPartsBudget,
  type DatasetConfig,
  type FilterValue,
} from '@genai/port-knowledge';
import { bestChunk, textRankCap } from './sql.js';

/** SQLSTATE a read function raises when this server does not hold the generation it was asked for. */
export const notReadyCode = 'KN503';

/** The functions the reader may execute; everything else on the knowledge server is the owner's. */
export const readFunctions = [
  'kn_generation(text, text)',
  'kn_search(text, text, text, text, text, halfvec, text[], jsonb, integer, integer, integer)',
  'kn_fetch(text, text, text[])',
  'kn_range(text, text, text, integer, integer)',
  'kn_parts(text, text, text, text, integer, integer)',
  'kn_facets(text, text, text[], jsonb)',
  'kn_documents(text, text, text[], jsonb, integer, integer)',
  'kn_resolve_citation(text, text, text[], text[])',
] as const;

/** Owner-only helpers: the checks, and one function per read that returns the statement it runs. */
export const readHelpers = [
  'kn_allowed(text)',
  'kn_attached(text, text)',
  'kn_list_sql(text)',
  'kn_text_sql(text)',
  'kn_filter_sql(jsonb, text)',
  'kn_versioned_sql(text, text)',
  'kn_search_sql(text, text, text, text, text, halfvec, text[], jsonb, integer, integer, integer)',
  'kn_fetch_sql(text, text, text[])',
  'kn_range_sql(text, text, text, integer, integer)',
  'kn_parts_sql(text, text, text, text, integer, integer)',
  'kn_facets_sql(text, text, text, jsonb)',
  'kn_documents_sql(text, text, text[], jsonb, integer, integer)',
  'kn_resolve_citation_sql(text, text, text[], text[])',
] as const;

/** What `kn_parts` returns: one row a part, and a last row with no `seq` when the budget cut the read. */
const partColumns = `seq integer, kind text, level integer, heading_path jsonb, text text, start integer, "end" integer, regions jsonb, units jsonb`;

const definer = `language plpgsql stable security definer set search_path = pg_catalog, public`;
const hitColumns = `id text, text text, doc_id text, "position" integer, metadata jsonb, title text, url text, fields jsonb, page_from integer, page_to integer, file text, file_sha256 text, heading_path text[], score double precision, total integer, data_version bigint`;
const hitSelect = `c.id, c.text, c.doc_id, c.position, c.metadata, d.title, d.url, d.fields, c.page_from, c.page_to, c.file, c.file_sha256, c.heading_path`;

/** The generation's partition is named by literals, so the planner reads that partition only. */
const docJoin = (alias: string) =>
  `'join kn_docs d on d.dataset = ' || ds || ' and d.generation = ' || g || ' and d.id = ${alias}.doc_id'`;

/**
 * A text search's ranked matches for the tsquery literal in `q`: the matches are planned uncapped, then at most `textRankCap` are read.
 * For the docs target, documents are ranked and cut first, then each gets the chunk that best matches the query (`bestChunk`).
 */
const rankedSql = (q: string) => `case when p_target = 'docs' then format(
             'with m as materialized (select d.id as doc, %2$s as tsv from kn_docs d
                where d.dataset = %3$s and d.generation = %4$s and %2$s @@ %1$s and %5$s),
              top as (select doc, tsv, ts_rank_cd(tsv, %1$s)::float8 as s from (select doc, tsv from m limit ${textRankCap}) m
                order by s desc, doc limit %6$s)
              select best.id, top.s from top
              cross join lateral (${bestChunk('%7$s', 'top', '%3$s', '%4$s').replaceAll("'", "''")}) best
              order by top.s desc, best.id',
             ${q}, tsv, ds, g, where_sql, p_candidates, q)
           else format(
             'with m as materialized (select %2$s as id, x.tsv from %3$s x
                where x.dataset = %4$s and x.generation = %5$s and x.tsv @@ %1$s%6$s)
              select id, max(ts_rank_cd(m.tsv, %1$s))::float8 as s from (select id, tsv from m limit ${textRankCap}) m
              group by id order by s desc, id limit %7$s',
             ${q}, id_col, tbl, ds, g, doc_filter, p_candidates) end`;

const createFunctions = (filtered: FilteredSearch) => [
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
  // Adds the generation's data version on this server to every row a read statement returns.
  `create or replace function kn_versioned_sql(p_generation text, p_sql text) returns text
     language plpgsql stable set search_path = pg_catalog, public as $$
     declare v bigint;
     begin
       select k.data_version into v from kn_generations k where k.generation = p_generation;
       return format('select s.*, %s::bigint from (%s) s', coalesce(v, 0), p_sql);
     end $$`,
  // Clauses come normalised by the engine; select, multiselect and boolean are containment on fields,
  // so the partition's jsonb_path_ops index serves them, and integer ranges use its kn_int index.
  `create or replace function kn_filter_sql(p_filters jsonb, p_config text) returns text
     language plpgsql immutable set search_path = pg_catalog, public as $$
     declare
       c jsonb; f text; json text; part text; q text; parts text[] := '{}';
     begin
       for c in select x from jsonb_array_elements(coalesce(p_filters, '[]')) x loop
         f := c->>'field';
         -- A document's id and title are columns of their own, never in its fields.
         json := case f when 'doc_num' then 'to_jsonb(d.id)' when 'title' then 'to_jsonb(d.title)'
                        else format('d.fields -> %L', f) end;
         if c->>'op' in ('in', 'not') and f in ('doc_num', 'title') then
           -- d.id is never null, so its condition stays bare: the documents' key finds the document,
           -- and the chunks' doc_id index its chunks, for the text and the vector half.
           select format(case f when 'doc_num' then 'd.id = any(%L::text[])' else 'coalesce(d.title = any(%L::text[]), false)' end,
                     coalesce(array_agg(v #>> '{}'), '{}'))
             into part from jsonb_array_elements(c->'values') v;
           if c->>'op' = 'not' then part := 'not ' || part; end if;
         elsif c->>'op' in ('in', 'not') then
           select '(' || coalesce(string_agg(format('d.fields @> %L::jsonb or d.fields @> %L::jsonb',
                     jsonb_build_object(f, v), jsonb_build_object(f, jsonb_build_array(v))), ' or '), 'false') || ')'
             into part from jsonb_array_elements(c->'values') v;
           if c->>'op' = 'not' then part := 'not ' || part; end if;
         elsif c->>'op' = 'text' then
           -- Every word of one option must match; the options are alternatives. A row from an API
           -- before options came keeps its meaning then: any of its words.
           if c ? 'options' then
             select string_agg('(' || o || ')', ' | ') into q from (
               select plainto_tsquery(p_config::regconfig, e #>> '{}')::text o
               from jsonb_array_elements(c->'options') e) s
             where o <> '';
           else
             q := nullif(replace(plainto_tsquery(p_config::regconfig, c->>'terms')::text, ' & ', ' | '), '');
           end if;
           part := case when q is null then 'false' else format('%s @@ %L::tsquery',
             case f when 'title' then 'd.title_tsv'
                    else format('to_tsvector(%L::regconfig, %s)', p_config, kn_text_sql(json)) end, q) end;
         elsif c->>'op' = 'int' then
           part := concat_ws(' and ',
             case when c ? 'gte' then format('kn_int(%s) >= %s::bigint', json, (c->>'gte')::bigint) end,
             case when c ? 'lte' then format('kn_int(%s) <= %s::bigint', json, (c->>'lte')::bigint) end);
         elsif c->>'op' = 'str' then
           -- Matches the partition's index on kn_text(...) collate "C".
           part := concat_ws(' and ',
             case when c ? 'gte' then format('kn_text(%s) collate "C" >= %L::text', json, c->>'gte') end,
             case when c ? 'lte' then format('kn_text(%s) collate "C" <= %L::text', json, c->>'lte') end);
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
     -- Volatile: a filtered vector half reads the filter's size and may raise the index scan's limits.
     returns text language plpgsql volatile set search_path = pg_catalog, public as $$
     declare
       ds text := quote_literal(p_dataset);
       g text := quote_literal(p_generation);
       recipe jsonb;
       matched integer;
       filtered_docs text;
       filtered_chunks text;
       exact boolean := false;
       cfg text;
       dims integer;
       where_sql text;
       doc_filter text;
       use_text boolean := p_mode <> 'vector';
       use_vector boolean := p_mode <> 'text' and p_vector is not null;
       match_all boolean := btrim(p_query) = '*';
       q text;
       q_any text;
       ranked text;
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
       doc_filter := case when where_sql = 'true' then '' else format(
         ' and exists (select 1 from kn_docs d where d.dataset = %s and d.generation = %s and d.id = x.doc_id and %s)',
         ds, g, where_sql) end;
       tbl := case p_target when 'chunks' then 'kn_chunks' else 'kn_phrases' end;
       id_col := case p_target when 'chunks' then 'x.id' else 'x.chunk_id' end;
       tsv := case
         when p_fields is null then 'd.tsv'
         when p_fields = array['title'] then 'd.title_tsv'
         else format('to_tsvector(%L::regconfig, concat_ws('' '', %s))', cfg,
           (select string_agg(case when f = 'title' then 'coalesce(d.title, '''')'
                                   else kn_text_sql(format('d.fields -> %L', f)) end, ', ')
              from unnest(p_fields) f))
       end;
       if use_text and match_all then
         if p_target = 'docs' then
           ctes := ctes || format(
             't as (select first.id, 0::float8 as s from kn_docs d
                cross join lateral (select c.id from kn_chunks c
                  where c.dataset = %s and c.generation = %s and c.doc_id = d.id order by c.position limit 1) first
                where d.dataset = %s and d.generation = %s and %s
                order by s desc, first.id limit %s)',
             ds, g, ds, g, where_sql, p_candidates);
         else
           ctes := ctes || format(
             't as (select %s as id, 0::float8 as s from %s x %s
                where x.dataset = %s and x.generation = %s and %s
                group by %s order by s desc, id limit %s)',
             id_col, tbl, ${docJoin('x')}, ds, g, where_sql, id_col, p_candidates);
         end if;
       elsif use_text then
         -- Every word must match; quoted words match as a phrase.
         q := format('%L::tsquery', websearch_to_tsquery(cfg::regconfig, p_query)::text);
         ranked := ${rankedSql('q')};
         -- A text profile, with no vector half to fill the list, adds some-words matches below the all-words ones.
         if p_mode = 'text' then
           q_any := format('%L::tsquery', replace(plainto_tsquery(cfg::regconfig, p_query)::text, ' & ', ' | '));
           ctes := ctes || format(
             't_all as (%s), t_any as (%s),
              t as (select id, s from (
                select id, 1 + s / (1 + s) as s from t_all
                union all
                select id, s / (1 + s) from t_any
                where (select count(*) from t_all) < %s and strpos(%s::text, ''!'') = 0
                  and id not in (select id from t_all)) u
                order by s desc, id limit %s)',
             ranked, ${rankedSql('q_any')}, p_candidates, q, p_candidates);
         else
           ctes := ctes || format('t as (%s)', ranked);
         end if;
       end if;
       if use_vector then
         tbl := case p_target when 'phrases' then 'kn_phrases' else 'kn_chunks' end;
         id_col := case p_target when 'phrases' then 'x.chunk_id' else 'x.id' end;
         -- The cast matches the partition's HNSW index on vec::halfvec(N).
         dist := format('x.vec::halfvec(%s) <=> %L::halfvec(%s)', dims, p_vector::text, dims);
         -- A small filter is ranked exactly, documents first; the count reads the doc index alone (issue 800).
         if where_sql <> 'true' then
           filtered_docs := format('(select d.id from kn_docs d where d.dataset = %s and d.generation = %s and %s) m',
             ds, g, where_sql);
           execute format('select count(*)::int from (select 1 from %s
               cross join lateral (select 1 from %s x where x.generation = %s and x.doc_id = m.id offset 0) x
               limit %s) n',
             filtered_docs, tbl, g, ${Math.trunc(filtered.exactChunks) + 1}) into matched;
           filtered_chunks := format('%s cross join lateral (select %s as id, x.vec from %s x
               where x.dataset = %s and x.generation = %s and x.doc_id = m.id and x.vec is not null offset 0) x',
             filtered_docs, id_col, tbl, ds, g);
           exact := matched <= ${Math.trunc(filtered.exactChunks)};
           if not exact then
             -- For this read's transaction only, and never below the server's own.
             perform set_config('hnsw.ef_search', greatest(coalesce(current_setting('hnsw.ef_search', true), '0')::int,
                       ${Math.trunc(filtered.efSearch)})::text, true),
                     set_config('hnsw.max_scan_tuples', greatest(coalesce(current_setting('hnsw.max_scan_tuples', true), '0')::int,
                       ${Math.trunc(filtered.maxScanTuples)})::text, true),
                     set_config('hnsw.scan_mem_multiplier', greatest(coalesce(current_setting('hnsw.scan_mem_multiplier', true), '0')::float8,
                       ${Number(filtered.scanMemMultiplier)})::text, true);
           end if;
         else
           -- An unfiltered search reads the index deeper too (issue 674), for this read's transaction only and
           -- never below the server's own; its other limits stay the server's.
           perform set_config('hnsw.ef_search', greatest(coalesce(current_setting('hnsw.ef_search', true), '0')::int,
                     ${Math.trunc(filtered.unfilteredEfSearch)})::text, true);
         end if;
         if exact then
           -- Sorted above the documents-first join, so no HNSW scan; each distance computed once, a zero vector's NaN left out.
           ctes := ctes || format(
             'v as (select id, max(s) as s from (
                select n.id, (1 - n.d)::float8 as s from (select x.id, %s as d from %s offset 0) n
                where n.d <> ''NaN''::float8 order by n.d, n.id limit %s) nearest group by id)',
             dist, filtered_chunks, p_candidates);
         else
           ctes := ctes || format(
             'v as (select id, max(s) as s from (
                select %s as id, (1 - (%s))::float8 as s from %s x %s
                where x.dataset = %s and x.generation = %s and x.vec is not null and %s
                order by %s limit %s) nearest group by id)',
             id_col, dist, tbl, ${docJoin('x')}, ds, g, where_sql, dist, p_candidates);
         end if;
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
  // The parts around a hit (ADR 0055, "Chunks and reads"), from the chunk row in the generation's
  // partition: its conversion is never named by the caller. Only body parts, in reading order; the
  // budget is spent from the hit outwards (side -1 before it, 0 in it, 1 after it, then by nearness),
  // so a cut read keeps the hit. readPartsAround in @genai/port-knowledge states the same reads.
  `create or replace function kn_parts_sql(p_dataset text, p_generation text, p_chunk_id text, p_read text, p_n integer, p_budget integer)
     returns text language plpgsql stable set search_path = pg_catalog, public as $$
     declare
       ds text := quote_literal(p_dataset); g text := quote_literal(p_generation);
       n integer := least(greatest(coalesce(p_n, 0), 0), ${maxPartsAround});
       budget integer := least(greatest(coalesce(p_budget, 0), 0), ${maxPartsBudget});
       rows_sql text; chosen text;
     begin
       -- A server whose chunks have no parts columns yet holds no chunk made from parts (issue 635).
       if not exists (select 1 from pg_attribute where attrelid = 'kn_chunks'::regclass
                        and attname = 'conversion' and not attisdropped) then
         return 'select null::int, null::text, null::int, null::jsonb, null::text, null::int, null::int, null::jsonb, null::jsonb where false';
       end if;
       -- A units read takes only the rows whose parts reach the units around the hit.
       rows_sql := case when p_read = 'units' then
           'select u.unit, u.parts from src_conversion_units u, hit, span
             where u.conversion = hit.conversion and u.unit <= span.b and u.unit_to >= span.a'
         else
           'select u.unit, u.parts from src_conversion_units u, hit where u.conversion = hit.conversion'
         end;
       chosen := case p_read
         when 'neighbours' then format(
           'select b.* from body b, hit where b.seq between hit.seq_from and hit.seq_to
            union all (select b.* from body b, hit where b.seq < hit.seq_from order by b.seq desc limit %1$s)
            union all (select b.* from body b, hit where b.seq > hit.seq_to order by b.seq limit %1$s)', n)
         when 'section' then
           'select b.* from body b, hit
             where b.seq >= coalesce((select max(h.seq) from body h where h.heading and h.seq <= hit.seq_from), -1)
               and b.seq < coalesce((select min(h.seq) from body h where h.heading and h.seq > hit.seq_to), 2147483647)'
         when 'units' then
           'select b.* from body b, span
             where exists (select 1 from jsonb_array_elements(b.x->''regions'') r
                            where (r->>''unit'')::int between span.a and span.b)'
         else null end;
       if chosen is null then
         raise exception 'a read is neighbours, section or units' using errcode = '22023';
       end if;
       return format(
         'with hit as materialized (
             select c.conversion, c.seq_from, c.seq_to from kn_chunks c
              where c.dataset = %1$s and c.generation = %2$s and c.id = %3$L
                and c.conversion is not null and c.seq_from is not null),
           span as materialized (
             select min((r->>''unit'')::int) - %4$s as a, max((r->>''unit'')::int) + %4$s as b
               from hit
               join src_conversion_units u on u.conversion = hit.conversion
                and u.seq_from <= hit.seq_to and u.seq_to >= hit.seq_from
               cross join lateral jsonb_array_elements(u.parts) x
               cross join lateral jsonb_array_elements(x->''regions'') r
              where (x->>''seq'')::int between hit.seq_from and hit.seq_to and x->>''layer'' = ''body''),
           rows as materialized (%5$s),
           body as materialized (
             select (x->>''seq'')::int as seq, x->>''kind'' in (''section_header'', ''title'') as heading, x
               from rows cross join lateral jsonb_array_elements(rows.parts) x
              where x->>''layer'' = ''body''),
           chosen as (%6$s),
           sided as (
             select c.seq, c.x,
                    case when c.seq < hit.seq_from then -1 when c.seq > hit.seq_to then 1 else 0 end as side
               from chosen c, hit),
           ranked as (
             select s.seq, s.x, case when s.side = 0 then 0 else
                      row_number() over (partition by s.side order by s.side * s.seq) end as near
               from sided s),
           totalled as (
             select r.seq, r.x,
                    sum(char_length(coalesce(r.x->>''text'', ''''))) over (order by r.near, r.seq) as total
               from ranked r)
         select t.seq, t.x->>''kind'', (t.x->>''level'')::int, coalesce(t.x->''headingPath'', ''[]''),
                coalesce(t.x->>''text'', ''''), (t.x->>''start'')::int, (t.x->>''end'')::int,
                coalesce(t.x->''regions'', ''[]''),
                (select coalesce(jsonb_agg(jsonb_build_object(''unit'', l.unit, ''label'', l.label) order by l.unit), ''[]'')
                   from src_conversion_units l, hit
                  where l.conversion = hit.conversion
                    and l.unit in (select (r->>''unit'')::int from jsonb_array_elements(t.x->''regions'') r))
           from totalled t where t.total <= %7$s
         union all
         select null, null, null, null, null, null, null, null, null
          where exists (select 1 from totalled t where t.total > %7$s)
         order by 1 nulls last',
         ds, g, p_chunk_id, n, rows_sql, chosen, budget);
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
  // The count covers every matching document, so a page past the end still reports it (on a row with no id).
  `create or replace function kn_documents_sql(p_dataset text, p_generation text, p_ids text[], p_filters jsonb, p_limit integer, p_offset integer)
     returns text language plpgsql stable set search_path = pg_catalog, public as $$
     declare
       ds text := quote_literal(p_dataset); g text := quote_literal(p_generation); cfg text;
     begin
       select coalesce(k.recipe->>'textSearchConfig', 'norwegian') into cfg
         from kn_generations k where k.generation = p_generation and k.dataset = p_dataset;
       return format('with m as (
             select d.id, d.title, d.url, d.fields from kn_docs d
             where d.dataset = %s and d.generation = %s and %s and %s),
           n as (select count(*)::int as total from m)
           select p.id, p.title, p.url,
             p.fields || jsonb_build_object(''total_chunks'', (select count(*) from kn_chunks c
               where c.dataset = %s and c.generation = %s and c.doc_id = p.id)),
             n.total
           from n left join lateral (select * from m order by m.id limit %s offset %s) p on true
           order by p.id',
         ds, g,
         case when p_ids is null then 'true' else format('d.id = any(%L::text[])', p_ids) end,
         kn_filter_sql(p_filters, coalesce(cfg, 'norwegian')), ds, g, p_limit, p_offset);
     end $$`,
  // The API passes each cited id with its keyed hash (ADR 0042), which tombstones hold instead of ids.
  `drop function if exists kn_resolve_citation_sql(text, text, text[])`,
  `create or replace function kn_resolve_citation_sql(p_dataset text, p_generation text, p_ids text[], p_id_hashes text[])
     returns text language plpgsql stable set search_path = pg_catalog, public as $$
     declare ds text := quote_literal(p_dataset); g text := quote_literal(p_generation);
     begin
       return format('select c.cited,
             case when d.id is not null then ''found'' when e.id is not null then ''earlier''
                  when t.id_hash is not null then ''withdrawn'' else ''unknown'' end,
             coalesce(d.id, e.id), coalesce(d.title, e.title), coalesce(d.url, e.url),
             case when d.id is null and e.id is null then t.deleted_on end
           from unnest(%L::text[], %L::text[]) with ordinality c(cited, id_hash, n)
           left join kn_docs d on d.dataset = %s and d.generation = %s and d.id = c.cited
           left join lateral (select x.id, x.title, x.url from src_documents r
               join kn_docs x on x.dataset = %s and x.generation = %s and x.id = r.id
               where r.dataset = %s and r.earlier_ids @> array[c.cited] order by r.id limit 1) e on d.id is null
           left join src_tombstones t on t.dataset = %s and t.id_hash = c.id_hash
           order by c.n',
         p_ids, p_id_hashes, ds, g, ds, g, ds, ds);
     end $$`,
  // Return types gained data_version, and the hits their chunk's page, file and heading path,
  // which create or replace cannot change: a hit function whose columns are not this release's,
  // older or newer (after a rollback), is dropped and created again in the migration's transaction.
  `do $$ declare f regprocedure;
   begin
     for f in select p.oid::regprocedure from pg_proc p
                where p.pronamespace = 'public'::regnamespace
                  and p.proname in ('kn_search', 'kn_fetch', 'kn_range', 'kn_facets', 'kn_documents', 'kn_resolve_citation')
                  and (not ('data_version' = any(coalesce(p.proargnames, '{}')))
                       or (p.proname in ('kn_search', 'kn_fetch', 'kn_range')
                           and replace(pg_get_function_result(p.oid), '"', '')
                               <> 'TABLE(${hitColumns.replaceAll('"', '')})')) loop
       execute format('drop function %s', f);
     end loop;
   end $$`,
  `create or replace function kn_generation(p_dataset text, p_generation text) returns jsonb ${definer} as $$
     declare v_recipe jsonb;
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       select k.recipe || jsonb_build_object('dataVersion', k.data_version) into v_recipe
         from kn_generations k where k.generation = p_generation;
       return v_recipe;
     end $$`,
  `create or replace function kn_search(
       p_dataset text, p_generation text, p_target text, p_mode text, p_query text, p_vector halfvec,
       p_fields text[], p_filters jsonb, p_limit integer, p_candidates integer, p_rrf_k integer)
     returns table (${hitColumns}) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_versioned_sql(p_generation, kn_search_sql(p_dataset, p_generation, p_target, p_mode, p_query, p_vector,
         p_fields, p_filters, p_limit, p_candidates, p_rrf_k));
     end $$`,
  `create or replace function kn_fetch(p_dataset text, p_generation text, p_ids text[])
     returns table (${hitColumns}) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_versioned_sql(p_generation, kn_fetch_sql(p_dataset, p_generation, p_ids));
     end $$`,
  `create or replace function kn_range(p_dataset text, p_generation text, p_document text, p_from integer, p_to integer)
     returns table (${hitColumns}) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_versioned_sql(p_generation, kn_range_sql(p_dataset, p_generation, p_document, p_from, p_to));
     end $$`,
  `create or replace function kn_parts(p_dataset text, p_generation text, p_chunk_id text, p_read text, p_n integer, p_budget integer)
     returns table (${partColumns}, data_version bigint) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_versioned_sql(p_generation,
         kn_parts_sql(p_dataset, p_generation, p_chunk_id, p_read, p_n, p_budget));
     end $$`,
  `create or replace function kn_facets(p_dataset text, p_generation text, p_fields text[], p_filters jsonb)
     returns table (field text, value text, count integer, data_version bigint) ${definer} as $$
     declare f text;
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       foreach f in array coalesce(p_fields, '{}') loop
         return query execute kn_versioned_sql(p_generation, kn_facets_sql(p_dataset, p_generation, f, p_filters));
       end loop;
     end $$`,
  `create or replace function kn_documents(p_dataset text, p_generation text, p_ids text[], p_filters jsonb, p_limit integer, p_offset integer)
     returns table (id text, title text, url text, fields jsonb, total integer, data_version bigint) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_versioned_sql(p_generation, kn_documents_sql(p_dataset, p_generation, p_ids, p_filters, p_limit, p_offset));
     end $$`,
  `create or replace function kn_resolve_citation(p_dataset text, p_generation text, p_ids text[], p_id_hashes text[])
     returns table (cited text, status text, document text, title text, url text, withdrawn_on date, data_version bigint) ${definer} as $$
     begin
       perform kn_allowed(p_dataset);
       perform kn_attached(p_dataset, p_generation);
       return query execute kn_versioned_sql(p_generation, kn_resolve_citation_sql(p_dataset, p_generation, p_ids, p_id_hashes));
     end $$`,
];

/** How a vector search reads a generation: filtered (issue 800) and unfiltered (issue 674). */
export interface FilteredSearch {
  /** A filter that keeps at most this many rows (chunks, or phrases) is ranked exactly, without the HNSW index. */
  exactChunks: number;
  /** Above it, the index scan's limits for that search's transaction; never below the server's own. */
  efSearch: number;
  maxScanTuples: number;
  scanMemMultiplier: number;
  /** An unfiltered search's `hnsw.ef_search`, for its transaction; never below the server's own (issue 674). */
  unfilteredEfSearch: number;
}

// Measured on Kudos in test (issue 800); the numbers are in ADR 0042.
export const filteredSearch: FilteredSearch = {
  exactChunks: 250_000,
  efSearch: 200,
  maxScanTuples: 100_000,
  scanMemMultiplier: 4,
  // Issue 674: on Kudos, real questions without a filter got recall@10 0.914 at 40, 0.942 at 100 and 0.966 at 200.
  unfilteredEfSearch: 200,
};

/** Read-function migrations for the knowledge-server list; the reader reaches data only through these. */
export const readFunctionMigrations = (
  reader: string,
  filtered: FilteredSearch = filteredSearch,
): string[] => [
  ...createFunctions(filtered),
  `revoke execute on function ${[...readFunctions, ...readHelpers].join(', ')} from public`,
  `grant execute on function ${readFunctions.join(', ')} to ${reader}`,
];

export type FilterClauseRow =
  | { field: string; op: 'in' | 'not'; values: unknown[] }
  | { field: string; op: 'text'; terms: string; options: string[] }
  | { field: string; op: 'int'; gte?: number; lte?: number }
  | { field: string; op: 'str'; gte?: string; lte?: string }
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
          return { field, op: 'text', terms: String(clause), options: [String(clause)] };
        return { field, op: 'in', values: [clause] };
      }
      if (Array.isArray(clause)) return { field, op: 'in', values: clause };
      if ('not' in clause) return { field, op: 'not', values: clause.not };
      if ('contains' in clause)
        return {
          field,
          op: 'text',
          terms: clause.contains.join(' '),
          options: clause.contains.map(String),
        };
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
      const text =
        dataset.valueTypes?.[field] !== 'integer' &&
        [clause.gte, clause.lte].every((b) => b === undefined || typeof b === 'string');
      if (text)
        return {
          field,
          op: 'str',
          ...(typeof clause.gte === 'string' ? { gte: clause.gte } : {}),
          ...(typeof clause.lte === 'string' ? { lte: clause.lte } : {}),
        };
      return {
        field,
        op: 'range',
        ...(clause.gte === undefined ? {} : { gte: clause.gte }),
        ...(clause.lte === undefined ? {} : { lte: clause.lte }),
      };
    });
  });
