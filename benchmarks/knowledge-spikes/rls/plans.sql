\pset pager off
select vec::text as q from kn where dataset = 'b' and id = 10 \gset
set hnsw.iterative_scan = relaxed_order;
\echo '#### 1. Full-text search: owner (no RLS)'
explain (analyze, costs off, summary on) select id from kn where dataset = 'a' and tsv @@ to_tsquery('simple', 'w4242') limit 10;
\echo '#### 1. Full-text search: reader (RLS)'
begin; set local role reader; select set_config('app.datasets', 'a,b', true) \g /dev/null
explain (analyze, costs off, summary on) select id from kn where dataset = 'a' and tsv @@ to_tsquery('simple', 'w4242') limit 10;
commit;
\echo '#### 2. jsonb filter: owner'
explain (analyze, costs off, summary on) select count(*) from kn where dataset = 'b' and fields @> '{"type": "t10"}';
\echo '#### 2. jsonb filter: reader (RLS)'
begin; set local role reader; select set_config('app.datasets', 'a,b', true) \g /dev/null
explain (analyze, costs off, summary on) select count(*) from kn where dataset = 'b' and fields @> '{"type": "t10"}';
commit;
\echo '#### 3. Vector search: owner'
explain (analyze, costs off, summary on) select id from kn where dataset = 'b' order by vec <=> :'q'::halfvec(64) limit 10;
\echo '#### 3. Vector search: reader (RLS)'
begin; set local role reader; select set_config('app.datasets', 'a,b', true) \g /dev/null
explain (analyze, costs off, summary on) select id from kn where dataset = 'b' order by vec <=> :'q'::halfvec(64) limit 10;
commit;
