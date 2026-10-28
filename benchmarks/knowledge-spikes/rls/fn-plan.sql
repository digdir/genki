load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_nested_statements = on;
set auto_explain.log_analyze = on;
set auto_explain.log_level = notice;
begin; set local role reader; select set_config('app.datasets', 'a,b', true) \g /dev/null
select count(*) from kn_text_search('a', to_tsquery('simple', 'w4242 | w17'), 50) \g /dev/null
commit;
