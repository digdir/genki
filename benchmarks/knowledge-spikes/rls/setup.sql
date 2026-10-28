create extension if not exists vector;
create extension if not exists pg_trgm;
-- Which functions behind our operators are leakproof?
select p.oid::regprocedure as function, p.proleakproof as leakproof
from pg_proc p
where p.oid in ('texteq(text,text)'::regprocedure, 'ts_match_vq(tsvector,tsquery)'::regprocedure,
                'jsonb_contains(jsonb,jsonb)'::regprocedure, 'similarity_op(text,text)'::regprocedure,
                'cosine_distance(halfvec,halfvec)'::regprocedure, 'int4eq(integer,integer)'::regprocedure)
order by 1;

create table kn (
  dataset text not null,
  id bigint not null,
  text text not null,
  tsv tsvector generated always as (to_tsvector('simple', text)) stored,
  fields jsonb not null,
  vec halfvec(64) not null,
  primary key (dataset, id)
);
insert into kn (dataset, id, text, fields, vec)
select case when g % 100 = 0 then 'c' when g % 10 = 0 then 'b' else 'a' end,
       g,
       (select string_agg('w' || (random() * 50000)::int, ' ') from generate_series(1, 30) where g > 0),
       jsonb_build_object('type', 't' || (g % 20)),
       (select array_agg(random())::real[] from generate_series(1, 64) where g > 0)::halfvec(64)
from generate_series(1, 200000) g;
create index kn_tsv on kn using gin (tsv);
create index kn_fields on kn using gin (fields);
create index kn_title_trgm on kn using gin (text gin_trgm_ops);
set maintenance_work_mem = '1GB';
create index kn_vec on kn using hnsw (vec halfvec_cosine_ops);
analyze kn;

alter table kn enable row level security;
create policy by_dataset on kn for select
  using (dataset = any (string_to_array(current_setting('app.datasets', true), ',')));
create role reader nologin;
grant select on kn to reader;
