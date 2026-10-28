-- One night: replace 1% of the documents in place, the way an in-place ingestion run does
begin;
with gone as (select id from live order by random() limit 180)
delete from live using gone where live.id = gone.id;
insert into live (src, vec)
select p.n, p.vec from pool p where not exists (select 1 from live l where l.src = p.n) order by random() limit 180;
commit;
