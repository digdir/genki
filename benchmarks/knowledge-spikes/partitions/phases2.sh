#!/bin/sh
# Spike 1, part 2: build the new generation with no searches running, then attach and detach it while 8 clients search.
# Expects kn_g2 loaded by part 1 without indexes.
S1=$(dirname "$0")
P="docker exec ${SPIKE_CONTAINER:-kn-adr-spike} psql -U genai -d bench -v ON_ERROR_STOP=1 -At"
mark() { echo "$(perl -MTime::HiRes=time -e 'printf "%d", time*1000') $1" >> $S1/phases2.txt; }
: > $S1/phases2.txt
mark build_start
$P -c "\timing on" -c "set max_parallel_maintenance_workers = 1" -c "alter table kn_g2 add primary key (generation, id)" -c "create index kn_g2_tsv on kn_g2 using gin (tsv)" -c "create index kn_g2_vec on kn_g2 using hnsw (vec halfvec_cosine_ops)" -c "alter table kn_g2 add constraint kn_g2_generation check (generation = 'g2')" -c "analyze kn_g2" > $S1/build2.out 2>&1
mark build_end
node $S1/load.mjs "${SPIKE_DB_URL:?set SPIKE_DB_URL to the spike database}" $S1/latency2.txt 8 &
LOAD=$!
sleep 60; mark baseline_start; sleep 120; mark baseline_end
mark attach_start
$P -c "set lock_timeout = '1s'" -c "\timing on" -c "alter table kn attach partition kn_g2 for values in ('g2')" > $S1/attach.out 2>&1; echo "attach exit $?" >> $S1/attach.out
mark attach_end
sleep 30
mark detach_start
$P -c "set lock_timeout = '1s'" -c "\timing on" -c "alter table kn detach partition kn_g2 concurrently" > $S1/detach.out 2>&1; echo "detach exit $?" >> $S1/detach.out
$P -c "\timing on" -c "drop table kn_g2" >> $S1/detach.out 2>&1
mark detach_end
sleep 30; mark cool_start; sleep 120; mark cool_end
kill -TERM $LOAD; wait $LOAD
echo done
