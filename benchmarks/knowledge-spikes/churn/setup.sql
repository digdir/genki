\timing on
create table live (id serial primary key, src int not null, vec halfvec(1536) not null) with (autovacuum_enabled = false);
insert into live (src, vec) select n, vec from pool order by random() limit 18000;
create index live_vec on live using hnsw (vec halfvec_cosine_ops);
