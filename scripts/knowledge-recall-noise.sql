-- The noise in the nightly recall check (issue 140, ADR 0042 "Heavy work"): recall@10 of an HNSW
-- index against exact search, for random samples of the table's own vectors as queries, repeated
-- per sample size on one unchanged index. The spread between samples is what a healthy night
-- varies by, so the check's margin sits a few standard deviations below it.
--
-- Run on pgvector 0.8.2 against a table `live (id text, vec halfvec(1536))` of real page vectors,
-- such as the Kudos pilot's 20,248 qwen3-8b pages shortened to 1,536 dimensions:
--   create table live as select id, vec::halfvec(1536) as vec from kn_chunks;
--   create index on live using hnsw (vec halfvec_cosine_ops) with (m = 16, ef_construction = 64);
--   \i scripts/knowledge-recall-noise.sql
-- The index has the recipe's m and ef_construction, and searches run at the default
-- hnsw.ef_search (40), as search does.

create or replace function pg_temp.sampled_recall(n int) returns double precision
language plpgsql as $$
declare
  q record;
  ann text[];
  exact text[];
  hits int := 0;
begin
  for q in select vec from live order by random() limit n loop
    set local enable_seqscan = off;
    set local enable_indexscan = on;
    ann := array(select id from live order by vec <=> q.vec limit 10);
    set local enable_seqscan = on;
    set local enable_indexscan = off;
    set local enable_bitmapscan = off;
    exact := array(select id from live order by vec <=> q.vec limit 10);
    hits := hits + cardinality(array(select unnest(ann) intersect select unnest(exact)));
  end loop;
  return hits::double precision / (n * 10);
end $$;

create temp table noise (sample int, round int, recall double precision);

do $$ begin
  for s in 1..4 loop
    for r in 1..20 loop
      insert into noise values ((array[50, 100, 200, 500])[s], r,
                                pg_temp.sampled_recall((array[50, 100, 200, 500])[s]));
    end loop;
  end loop;
end $$;

select sample, count(*) as rounds, round(avg(recall)::numeric, 4) as mean,
       round(stddev_samp(recall)::numeric, 4) as sd, round(min(recall)::numeric, 4) as lowest
  from noise group by sample order by sample;
