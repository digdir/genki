\timing off
drop schema if exists rlstest cascade;
drop role if exists kreader;
create schema rlstest;
set search_path = rlstest, public;
create table kc (dataset text not null, generation text not null, id int not null, tsv tsvector not null, primary key (generation, id)) partition by list (generation);
create table kc_g1 partition of kc for values in ('g1');
create table kc_g2 partition of kc for values in ('g2');
insert into kc select 'ds1', 'g1', i, to_tsvector('simple', 'w' || (i % 5000) || ' v' || (i % 777)) from generate_series(1, 200000) i;
insert into kc select 'ds2', 'g2', i, to_tsvector('simple', 'w' || (i % 5000) || ' v' || (i % 777)) from generate_series(1, 200000) i;
create index on kc_g1 using gin (tsv);
create index on kc_g2 using gin (tsv);
analyze kc;
create function may_read(ds text) returns boolean language sql stable
  as $$ select ds = any(string_to_array(current_setting('app.datasets', true), ',')) $$;
-- policy that does not read the row: a constant per partition
alter table kc_g1 enable row level security;
create policy p on kc_g1 using (may_read('ds1'));
alter table kc_g2 enable row level security;
create policy p on kc_g2 using (may_read('ds2'));
create role kreader;
grant usage on schema rlstest to kreader;
grant select on kc_g1, kc_g2 to kreader;
grant execute on function may_read(text) to kreader;
\echo '== owner, no RLS applies (table owner)'
explain (analyze, costs off, timing on, summary on) select id from kc_g1 where tsv @@ to_tsquery('simple', 'w42') order by id limit 50;
set role kreader;
set app.datasets = 'ds1';
\echo '== reader, allowed dataset, constant policy'
explain (analyze, costs off, timing on, summary on) select id from kc_g1 where tsv @@ to_tsquery('simple', 'w42') order by id limit 50;
select count(*) as allowed_rows from kc_g1 where tsv @@ to_tsquery('simple', 'w42');
set app.datasets = 'ds2';
\echo '== reader, other dataset'
select count(*) as other_rows from kc_g1 where tsv @@ to_tsquery('simple', 'w42');
\echo '== reader, through the parent'
select count(*) from kc;
reset role;
-- contrast: policy that reads the row
drop policy p on kc_g1;
create policy p on kc_g1 using (may_read(dataset));
set role kreader;
set app.datasets = 'ds1';
\echo '== reader, policy that reads the row'
explain (analyze, costs off, timing on, summary on) select id from kc_g1 where tsv @@ to_tsquery('simple', 'w42') order by id limit 50;
reset role;
