-- Reads through a SECURITY DEFINER function on a table partitioned by generation, with 301 partitions.
-- Run as a superuser in a pgvector/pgvector:0.8.2-pg17 container: psql -f definer-partitions.sql
\timing off
drop schema if exists deftest cascade;
drop role if exists kreader2;
create schema deftest;
set search_path = deftest, public;
create table kc (dataset text not null, generation text not null, id int not null, tsv tsvector not null, primary key (generation, id)) partition by list (generation);
create table kc_g0 partition of kc for values in ('g0');
insert into kc_g0 select 'ds0', 'g0', i, to_tsvector('simple', 'w' || (i % 5000) || ' v' || (i % 777)) from generate_series(1, 200000) i;
create index on kc_g0 using gin (tsv);
do $$ begin
  for n in 1..300 loop
    execute format('create table kc_g%s partition of kc for values in (%L)', n, 'g' || n);
    execute format('insert into kc_g%s select %L, %L, i, to_tsvector(''simple'', ''w'' || i) from generate_series(1, 200) i', n, 'ds' || n, 'g' || n);
    execute format('create index on kc_g%s using gin (tsv)', n);
  end loop;
end $$;
analyze kc;
create function require_dataset(ds text) returns void language plpgsql stable as $$ begin
  if not ds = any(string_to_array(current_setting('app.datasets', true), ',')) then
    raise exception 'dataset % is not allowed', ds using errcode = '42501';
  end if;
end $$;
-- PL/pgSQL with the dataset and generation as literals in dynamic SQL
create function kn_search_text(ds text, gen text, q text) returns table (id int) language plpgsql stable security definer
  set search_path = deftest, public as $$ begin
  perform require_dataset(ds);
  return query execute format(
    'select id from kc where dataset = %L and generation = %L and tsv @@ to_tsquery(''simple'', %L) order by id limit 50', ds, gen, q);
end $$;
-- plain SQL function with parameters, for contrast
create function kn_search_sql(ds text, gen text, q text) returns table (id int) language sql stable security definer
  set search_path = deftest, public as $$
  select id from kc where dataset = ds and generation = gen and tsv @@ to_tsquery('simple', q) order by id limit 50 $$;
create role kreader2;
grant usage on schema deftest to kreader2;
grant execute on function kn_search_text(text, text, text), kn_search_sql(text, text, text) to kreader2;
\echo '== owner, direct read'
explain (analyze, costs off, summary on) select id from kc where dataset = 'ds0' and generation = 'g0' and tsv @@ to_tsquery('simple', 'w42') order by id limit 50;
set role kreader2;
set app.datasets = 'ds0';
\timing on
\echo '== reader, PL/pgSQL definer function (5 calls)'
select count(*) from kn_search_text('ds0', 'g0', 'w42');
select count(*) from kn_search_text('ds0', 'g0', 'w42');
select count(*) from kn_search_text('ds0', 'g0', 'w42');
select count(*) from kn_search_text('ds0', 'g0', 'w42');
select count(*) from kn_search_text('ds0', 'g0', 'w42');
\echo '== reader, SQL definer function (5 calls)'
select count(*) from kn_search_sql('ds0', 'g0', 'w42');
select count(*) from kn_search_sql('ds0', 'g0', 'w42');
select count(*) from kn_search_sql('ds0', 'g0', 'w42');
select count(*) from kn_search_sql('ds0', 'g0', 'w42');
select count(*) from kn_search_sql('ds0', 'g0', 'w42');
reset role;
\echo '== owner, direct read (5 calls)'
select count(*) from (select id from kc where dataset = 'ds0' and generation = 'g0' and tsv @@ to_tsquery('simple', 'w42') order by id limit 50) s;
select count(*) from (select id from kc where dataset = 'ds0' and generation = 'g0' and tsv @@ to_tsquery('simple', 'w42') order by id limit 50) s;
select count(*) from (select id from kc where dataset = 'ds0' and generation = 'g0' and tsv @@ to_tsquery('simple', 'w42') order by id limit 50) s;
select count(*) from (select id from kc where dataset = 'ds0' and generation = 'g0' and tsv @@ to_tsquery('simple', 'w42') order by id limit 50) s;
select count(*) from (select id from kc where dataset = 'ds0' and generation = 'g0' and tsv @@ to_tsquery('simple', 'w42') order by id limit 50) s;
\timing off
set role kreader2;
set app.datasets = 'ds0';
\echo '== reader, another dataset through the function'
select count(*) from kn_search_text('ds5', 'g5', 'w1');
\echo '== reader, direct read'
select count(*) from kc;
reset role;
