#!/bin/sh
set -e
P="psql -U postgres -d churn -v ON_ERROR_STOP=1"
$P -q -f /s2/setup.sql
echo "start recall: $($P -At -v tbl=live -f /s2/recall.sql | tail -1)"
for r in $(seq 1 20); do
  $P -q -f /s2/round.sql
  s=$(date +%s%N)
  $P -qc "vacuum live"
  e=$(date +%s%N)
  echo "round $r vacuum_ms=$(( (e - s) / 1000000 ))"
done
echo "rows: $($P -Atc 'select count(*) from live')"
echo "churned recall: $($P -At -v tbl=live -f /s2/recall.sql | tail -1)"
$P -qc "create table fresh as select * from live; create index fresh_vec on fresh using hnsw (vec halfvec_cosine_ops);"
echo "fresh-build recall: $($P -At -v tbl=fresh -f /s2/recall.sql | tail -1)"
$P -qc "set enable_indexscan = off; set enable_bitmapscan = off; drop table if exists x; create temp table x as select q.n, array(select id from live order by vec <=> q.vec limit 10) a, array(select id from fresh order by vec <=> q.vec limit 10) b from qtab q;" 
echo "same rows in both tables: $($P -Atc "select (select count(*) from live) = (select count(*) from fresh) and not exists (select id from live except select id from fresh)")"
