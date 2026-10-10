-- A fictional vault for the product pictures (scripts/demo-shots.sh): three
-- made-up people, their agents' proposals, variables with throwaway
-- ciphertext and one link. Runs as the database superuser on the local dev
-- stack, through the same API functions the web UI and MCP call, so what the
-- pictures show is what the product does. Synthetic data only: no real
-- client, no real value, no real credential anywhere in here.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned

\set ana 'a0000000-0000-4000-8000-000000000001'
\set ben 'a0000000-0000-4000-8000-000000000002'
\set cal 'a0000000-0000-4000-8000-000000000003'
\set vault_name 'Northwind relaunch'

select count(*) > 0 as seeded from public.vaults where name = :'vault_name' \gset
\if :seeded
  \echo demo vault already seeded
  \quit
\endif

create function pg_temp.as_person(p_user uuid, p_agent text default null) returns void language sql as $$
  select set_config('request.jwt.claims', case when p_agent is null
    then json_build_object('sub', p_user)::text
    else json_build_object('sub', p_user, 'act', json_build_object('sub', 'demo', 'name', p_agent))::text end, false),
         set_config('role', 'authenticated', false)
$$;
create function pg_temp.reset() returns void language sql as $$
  select set_config('role', 'none', false), set_config('request.jwt.claims', '', false)
$$;
-- Throwaway bytes in the shape of a sealed value. No key ever sealed them,
-- so nothing can open them; the pictures only ever show names.
create function pg_temp.junk(n int) returns bytea language sql as
$$ select substring(decode(md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text), 'hex') from 1 for n) $$;

insert into auth.users (id, email) values
  (:'ana', 'ana@northwind.example'),
  (:'ben', 'ben@northwind.example'),
  (:'cal', 'cal@brightline.example')
on conflict (id) do nothing;
-- Admitted by the operator, as on the hosted instance during the alpha.
insert into private.admissions (user_id, via) values (:'ana', 'operator'), (:'ben', 'operator'), (:'cal', 'operator')
on conflict (user_id) do nothing;

\o /dev/null
select pg_temp.as_person(:'ana');
select public.set_display_name('Ana Ruiz');
select public.create_vault(:'vault_name', 'open') as v \gset
select public.set_policy(:'v', 'canon/', 'canon', 1);
select public.create_invite(:'v', 'ben@northwind.example', 'editor') as ben_invite \gset
select public.create_invite(:'v', 'cal@brightline.example', 'editor') as cal_invite \gset
select pg_temp.reset();

select pg_temp.as_person(:'ben');
select public.set_display_name('Ben Okafor');
select public.accept_invite(:'ben_invite');
select pg_temp.reset();
select pg_temp.as_person(:'cal');
select public.set_display_name('Cal Meyer');
select public.accept_invite(:'cal_invite');
select pg_temp.reset();

-- Canon, written by Ana through proposals she approves herself.
select pg_temp.as_person(:'ana');
select public.propose(:'v', 'canon/brief.md', E'# Northwind relaunch: brief\n\n**Client:** Northwind Traders (fictional)\n**Agency lead:** Ana Ruiz\n**Launch:** 2026-11-18\n\n## What we are doing\n\nReplacing the 2019 storefront with a new one on the same catalogue. Checkout, search and the account area are in scope; the warehouse integration is not.\n\n## Audience\n\nTrade buyers who reorder the same 20 products every month. They want a reorder button, not a journey.\n\n## Success\n\n- Reorder in under a minute on a phone.\n- Search finds a product by its old SKU.\n- No drop in conversion in the first month.\n', 'Brief from the kickoff, 2026-10-01') as p \gset
select public.decide(:'p', 'approve');
select public.propose(:'v', 'canon/decisions.md', E'# Decisions\n\n| Date | Decision | Why |\n|---|---|---|\n| 2026-10-01 | Keep the old SKUs as search aliases | Trade buyers know them by heart |\n| 2026-10-03 | No guest checkout | Every order needs an account for the credit terms |\n| 2026-10-07 | Hosting in the EU | The client''s data processing terms require it |\n', 'Decisions so far') as p \gset
select public.decide(:'p', 'approve');
select public.propose(:'v', 'canon/style-guide.md', E'# Writing for Northwind\n\n- Sentence case everywhere, including buttons.\n- Say "reorder", never "repurchase".\n- Prices show VAT; the trade price is the default.\n- No exclamation marks.\n', 'Style guide agreed with the client') as p \gset
select public.decide(:'p', 'approve');
select public.propose(:'v', 'canon/runbook.md', E'# Runbook\n\n## Deploy\n\n- Deploy target: staging\n- Deploy with `npm run deploy` from a clean main branch.\n- Tell #northwind in chat before and after.\n\n## Rollback\n\n`npm run deploy -- --rollback` restores the previous release.\n', 'Runbook, first version') as p \gset
select public.decide(:'p', 'approve');
select pg_temp.reset();

-- Open folders: agents write notes directly.
select pg_temp.as_person(:'ben', 'Cursor');
select public.write_file(:'v', 'notes/standup-2026-10-09.md', E'# Standup, 2026-10-09\n\n- Ben: search aliases done, SKU lookup works.\n- Ana: client confirmed eu-production as the deploy target.\n- Cal: reviewing the style guide for the product pages.\n');
select pg_temp.reset();
select pg_temp.as_person(:'ana', 'Claude Code');
select public.write_file(:'v', 'notes/competitors.md', E'# Competitor notes\n\nThree trade suppliers looked at on 2026-10-08. All three bury reorder behind a login wall and none support the old SKU format. Draft only; nothing here is checked.\n');
select pg_temp.reset();

-- The core loop: Ana''s agent proposes a change to canon, waiting for her.
select pg_temp.as_person(:'ana', 'Claude Code');
select public.propose(:'v', 'canon/runbook.md', E'# Runbook\n\n## Deploy\n\n- Deploy target: eu-production\n- Deploy with `npm run deploy` from a clean main branch.\n- Tell #northwind in chat before and after.\n\n## Rollback\n\n`npm run deploy -- --rollback` restores the previous release.\n', 'The standup note of 2026-10-09 says the client confirmed eu-production, but the runbook still says staging.') as p_open \gset
select pg_temp.reset();
select pg_temp.as_person(:'ben');
select public.comment_on_proposal(:'p_open', 'Checked with ops: eu-production is right, DNS moved on Tuesday.');
select pg_temp.reset();

-- A second one waiting, from Ben''s agent.
select pg_temp.as_person(:'ben', 'Cursor');
select public.propose(:'v', 'canon/decisions.md', E'# Decisions\n\n| Date | Decision | Why |\n|---|---|---|\n| 2026-10-01 | Keep the old SKUs as search aliases | Trade buyers know them by heart |\n| 2026-10-03 | No guest checkout | Every order needs an account for the credit terms |\n| 2026-10-07 | Hosting in the EU | The client''s data processing terms require it |\n| 2026-10-09 | Search matches SKUs with or without the dash | Half the buyers type NW-1042, half NW1042 |\n', 'Decided in standup today; adding it so the next agent sees it.') as p_ben \gset
select pg_temp.reset();

-- One sent back with a note.
select pg_temp.as_person(:'cal', 'ChatGPT');
select public.propose(:'v', 'canon/style-guide.md', E'# Writing for Northwind\n\n- Sentence case everywhere, including buttons.\n- Say "reorder", never "repurchase".\n- Prices show VAT; the trade price is the default.\n- No exclamation marks.\n- Product names in Title Case.\n', 'Product names read better capitalised.') as p_cal \gset
select pg_temp.reset();
select pg_temp.as_person(:'ana');
select public.decide(:'p_cal', 'request_changes', 'The client''s catalogue is sentence case; let''s not fight it. Drop the last line.');
select pg_temp.reset();

-- Variables in the environments a vault starts with: names only, never a value.
select pg_temp.as_person(:'ana');
select public.set_variable(:'v', 'DATABASE_URL', 'development', 'k1', pg_temp.junk(12), pg_temp.junk(48));
select public.set_variable(:'v', 'DATABASE_URL', 'production', 'k1', pg_temp.junk(12), pg_temp.junk(48));
select public.set_variable(:'v', 'STRIPE_SECRET_KEY', 'development', 'k1', pg_temp.junk(12), pg_temp.junk(40));
select public.set_variable(:'v', 'STRIPE_SECRET_KEY', 'production', 'k1', pg_temp.junk(12), pg_temp.junk(40));
select public.set_variable(:'v', 'SEARCH_API_KEY', 'development', 'k1', pg_temp.junk(12), pg_temp.junk(32));
select public.set_variable(:'v', 'SEARCH_API_KEY', 'production', 'k1', pg_temp.junk(12), pg_temp.junk(32));
select public.set_variable(:'v', 'SENTRY_DSN', 'development', 'k1', pg_temp.junk(12), pg_temp.junk(60));

-- One link, with the tools it discovered.
select public.create_link(:'v', 'linear', 'https://mcp.linear.app/mcp', 'k1', pg_temp.junk(12), pg_temp.junk(40)) as lk \gset
select public.set_link_tools(:'lk', '[
  {"name": "list_issues", "is_write": false, "description": "List issues in a project"},
  {"name": "get_issue", "is_write": false, "description": "Read one issue"},
  {"name": "create_issue", "is_write": true, "description": "Open an issue"},
  {"name": "update_issue", "is_write": true, "description": "Change an issue"},
  {"name": "create_comment", "is_write": true, "description": "Comment on an issue"}
]'::jsonb);
select public.set_link_grant(:'lk', 'editor', 'list_issues', true);
select public.set_link_grant(:'lk', 'editor', 'get_issue', true);
select public.set_link_grant(:'lk', 'editor', 'create_comment', true);
select pg_temp.reset();
\o
\echo seeded :vault_name
