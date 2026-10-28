\pset pager off
create or replace function kn_text_search(p_dataset text, p_query tsquery, p_limit int)
returns table (id bigint, rank real)
language sql stable security definer set search_path = public as $$
  select id, ts_rank_cd(tsv, p_query)
  from kn
  where p_dataset = any (string_to_array(current_setting('app.datasets', true), ','))
    and dataset = p_dataset and tsv @@ p_query
  order by 2 desc limit p_limit
$$;
revoke all on function kn_text_search(text, tsquery, int) from public;
grant execute on function kn_text_search(text, tsquery, int) to reader;
\timing on
\echo '#### ranked full-text, owner (no RLS)'
select count(*) from (select id from kn where dataset = 'a' and tsv @@ to_tsquery('simple', 'w4242 | w17') order by ts_rank_cd(tsv, to_tsquery('simple', 'w4242 | w17')) desc limit 50) s;
select count(*) from (select id from kn where dataset = 'a' and tsv @@ to_tsquery('simple', 'w4242 | w17') order by ts_rank_cd(tsv, to_tsquery('simple', 'w4242 | w17')) desc limit 50) s;
\echo '#### ranked full-text, reader (RLS)'
begin; set local role reader; select set_config('app.datasets', 'a,b', true) \g /dev/null
select count(*) from (select id from kn where dataset = 'a' and tsv @@ to_tsquery('simple', 'w4242 | w17') order by ts_rank_cd(tsv, to_tsquery('simple', 'w4242 | w17')) desc limit 50) s;
select count(*) from (select id from kn where dataset = 'a' and tsv @@ to_tsquery('simple', 'w4242 | w17') order by ts_rank_cd(tsv, to_tsquery('simple', 'w4242 | w17')) desc limit 50) s;
\echo '#### same through the SECURITY DEFINER function, reader'
select count(*) from kn_text_search('a', to_tsquery('simple', 'w4242 | w17'), 50);
select count(*) from kn_text_search('a', to_tsquery('simple', 'w4242 | w17'), 50);
\echo '#### function asked for a dataset not in app.datasets'
select count(*) from kn_text_search('c', to_tsquery('simple', 'w4242 | w17'), 50);
commit;
