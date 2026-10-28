-- recall@10 of the HNSW index against exact search, for 676 Kudos questions
set hnsw.ef_search = 100;
drop table if exists ann, exact;
create temp table ann as select q.n, array(select id from :tbl order by vec <=> q.vec limit 10) ids from qtab q;
set enable_indexscan = off; set enable_bitmapscan = off;
create temp table exact as select q.n, array(select id from :tbl order by vec <=> q.vec limit 10) ids from qtab q;
select round(avg(cardinality(array(select unnest(a.ids) intersect select unnest(e.ids)))::numeric / 10), 4) as recall_at_10
from ann a join exact e using (n);
