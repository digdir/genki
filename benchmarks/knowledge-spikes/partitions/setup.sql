\timing on
drop table if exists kn cascade;
drop table if exists kn_g1, kn_g2, qv;
create table kn (generation text not null, id int not null, vec halfvec(1536) not null, tsv tsvector not null, primary key (generation, id)) partition by list (generation);
create table kn_g1 (like kn including defaults);
-- one synthetic 30-word text per row, words from a 50k vocabulary
insert into kn_g1 select 'g1', i.id, i.vec,
  to_tsvector('simple', (select string_agg('w' || (random() * 50000)::int, ' ') from generate_series(1, 30) where i.id >= 0))
from items i;
alter table kn_g1 add primary key (generation, id);
alter table kn_g1 add constraint kn_g1_generation check (generation = 'g1');
create index kn_g1_tsv on kn_g1 using gin (tsv);
create index kn_g1_vec on kn_g1 using hnsw (vec halfvec_cosine_ops);
alter table kn attach partition kn_g1 for values in ('g1');
create table qv as select row_number() over () as n, vec from (select vec from items order by random() limit 2000) s;
create unique index on qv (n);
vacuum analyze kn_g1; analyze qv;
select pg_size_pretty(pg_total_relation_size('kn_g1')) as g1_total, pg_size_pretty(pg_relation_size('kn_g1_vec')) as hnsw, pg_size_pretty(pg_relation_size('kn_g1_tsv')) as gin;
