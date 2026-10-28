#!/bin/sh
# Spike 1, part 1: copy and build a new generation beside the live one while 8 clients search, then attach and detach it.
# The run of 2026-10-27 was stopped during the build; part 2 (phases2.sh) measures attach and detach.
S1=$(dirname "$0"); S3=$S1
P="docker exec ${SPIKE_CONTAINER:-kn-adr-spike} psql -U genai -d bench -v ON_ERROR_STOP=1 -At"
mark() { echo "$(perl -MTime::HiRes=time -e 'printf "%d", time*1000') $1" >> $S1/phases.txt; }
: > $S1/phases.txt
node $S3/load.mjs "${SPIKE_DB_URL:?set SPIKE_DB_URL to the spike database}" $S1/latency.txt 8 &
LOAD=$!
sleep 10; mark baseline_start; sleep 180; mark baseline_end
mark load_start
$P -c "create table kn_g2 (like kn including defaults); insert into kn_g2 select 'g2', id, vec, tsv from kn_g1;" > $S1/load.out 2>&1
mark load_end
mark build_start
$P -c "set max_parallel_maintenance_workers = 1; alter table kn_g2 add primary key (generation, id); create index kn_g2_tsv on kn_g2 using gin (tsv); create index kn_g2_vec on kn_g2 using hnsw (vec halfvec_cosine_ops); alter table kn_g2 add constraint kn_g2_generation check (generation = 'g2'); analyze kn_g2;" > $S1/build.out 2>&1
mark build_end
sleep 30
mark attach_start
$P -c "set lock_timeout = '1s'" -c "\timing on" -c "alter table kn attach partition kn_g2 for values in ('g2')" > $S1/attach.out 2>&1; echo "attach exit $?" >> $S1/attach.out
mark attach_end
sleep 30
mark detach_start
$P -c "set lock_timeout = '1s'" -c "\timing on" -c "alter table kn detach partition kn_g2 concurrently" > $S1/detach.out 2>&1; echo "detach exit $?" >> $S1/detach.out
$P -c "\timing on" -c "drop table kn_g2" >> $S1/detach.out 2>&1
mark detach_end
sleep 60; mark cool_start; sleep 120; mark cool_end
kill -TERM $LOAD; wait $LOAD
echo done
