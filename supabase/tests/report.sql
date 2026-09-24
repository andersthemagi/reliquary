-- Shared test report. Included at the end of every *_test.sql.
\echo
select case when ok then 'PASS' else 'FAIL' end as result, name,
       case when ok then '' else detail end as detail
from t.results;

do $$
declare n_fail int := (select count(*) from t.results where not ok);
begin
  if n_fail > 0 then
    raise exception '% test(s) failed', n_fail;
  end if;
end $$;
