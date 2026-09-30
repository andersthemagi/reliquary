#!/usr/bin/env bash
Q="psql -h 127.0.0.1 -p 54329 -U postgres -d spike -X -At"
$Q -c "select 'distinct paths granted: '||count(*)||' | total grants: '||coalesce(sum(n),0)||' | worst path: '||coalesce(max(n),0)||' grants' from (select path, count(*) n from log where event='claim.granted' group by path) s"
