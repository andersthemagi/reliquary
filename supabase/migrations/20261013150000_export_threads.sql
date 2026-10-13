-- Threads in a vault's export (design.md, Threads item 10: "Threads belong
-- in the markdown export"; issue #197).
--
-- export_vault is 20260925160000_membership_polish.sql's, unchanged but for
-- two things read in its one snapshot statement, so the threads agree with
-- the files: the header gains the vault's threads (title, scope,
-- addressees, anchor, who opened it, resolved state, message count) and
-- the ids of everyone they name, and the export records the vault's latest
-- message id. export_messages then serves one thread's messages up to that
-- id, a page at a time, under export_files' rule: the owner, in person, who
-- started this export, within 2 hours.
--
-- A message's body is read when its page is served, not fixed at the start,
-- so a redaction made while an export runs wins, as erasure does for
-- files: a redacted message comes out with its place, author, agent and
-- time and no body, as read_thread gives it. Thread text isn't counted
-- against the export's 100 MiB of files: a vault's threads are bounded by
-- their own limits (10,000 messages of at most 4,000 characters).
--
-- A task anchor reads as its plan's path and step key, the citation a
-- person can follow (`task:<plan path>#<step key>`), since tasks are not
-- exported and a step's id means nothing outside the vault.

alter table private.vault_exports add column last_message_id bigint;

create or replace function public.export_vault(p_vault uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_export uuid := gen_random_uuid();
  v_header jsonb;
  v_files int;
  v_bytes bigint;
  v_last bigint;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners export a vault' using errcode = '42501';
  end if;
  -- One export starts at a time per vault, so the rate counts exactly.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.export:' || p_vault::text, 0));
  if (select count(*) from private.vault_exports
       where vault_id = p_vault and started_at > now() - interval '1 hour') >= private.export_rate() then
    raise exception 'this vault has been exported % times in the last hour: try again later', private.export_rate()
      using errcode = '54000';
  end if;
  delete from private.vault_exports where started_at < now() - interval '1 day';
  insert into private.vault_exports (id, vault_id, started_by) values (v_export, p_vault, private.uid());

  -- One statement, so one snapshot: the file list, the threads and the header agree.
  with live as (
    select f.path, fv.id as version_id, f.updated_at, octet_length(fv.body) as bytes
      from public.files f join public.file_versions fv on fv.id = f.current_version_id
     where f.vault_id = p_vault and f.deleted_at is null and fv.body is not null
  ), kept as (
    insert into private.vault_export_files (export_id, path, version_id, updated_at)
    select v_export, l.path, l.version_id, l.updated_at from live l
    returning 1
  ), th as (
    select s.* from public.thread_summaries s where s.vault_id = p_vault
  )
  select (select count(*) from kept)::int,
         (select coalesce(sum(l.bytes), 0) from live l)::bigint,
         (select max(th.last_message_id) from th),
         jsonb_build_object(
           'vault', (select jsonb_build_object('id', v.id, 'name', v.name, 'default_policy', v.default_policy,
                                               'created_at', v.created_at)
                       from public.vaults v where v.id = p_vault),
           'rules', coalesce((select jsonb_agg(jsonb_build_object('path', pp.path, 'policy', pp.policy,
                                                                  'quorum', pp.quorum) order by pp.path)
                                from public.path_policies pp where pp.vault_id = p_vault), '[]'),
           'variables', coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'environments', x.envs)
                                                   order by x.name)
                                    from (select va.name,
                                                 coalesce((select jsonb_agg(vv.environment order by vv.environment)
                                                             from public.variable_values vv
                                                            where vv.variable_id = va.id), '[]') as envs
                                            from public.variables va where va.vault_id = p_vault) x), '[]'),
           'threads', coalesce((select jsonb_agg(jsonb_build_object(
                                  'id', th.id, 'title', th.title, 'scope', th.scope,
                                  'addressees', to_jsonb(th.addressees),
                                  'anchor', case th.anchor_kind
                                    when 'path' then jsonb_build_object('kind', 'path', 'path', th.anchor_path)
                                    when 'proposal' then jsonb_build_object('kind', 'proposal', 'proposal', th.anchor_proposal)
                                    when 'task' then jsonb_build_object('kind', 'task', 'plan_path', th.anchor_plan_path,
                                                                        'step_key', th.anchor_step_key) end,
                                  'opened_by', th.opened_by, 'agent', th.agent, 'opened_at', th.opened_at,
                                  'resolved_at', th.resolved_at, 'resolved_by', th.resolved_by,
                                  'resolved_agent', th.resolved_agent, 'messages', th.messages)
                                  order by th.opened_at, th.id)
                                  from th), '[]'),
           'people', coalesce((select jsonb_agg(p.id order by p.id) from (
                                 select th.opened_by as id from th
                                 union select th.resolved_by from th
                                 union select unnest(th.addressees) from th
                                 union select m.author from public.thread_messages m where m.vault_id = p_vault
                                 union select m.redacted_by from public.thread_messages m where m.vault_id = p_vault) p
                               where p.id is not null), '[]'))
    into v_files, v_bytes, v_last, v_header;

  if v_bytes > private.export_cap() then
    raise exception 'this vault holds % MiB of text, over the export limit of % MiB',
      ceil(v_bytes / 1048576.0), private.export_cap() / 1048576 using errcode = '54000';
  end if;
  update private.vault_exports set last_message_id = v_last where id = v_export;
  perform private.log_event(p_vault, 'vault.export', null, null, null,
    jsonb_build_object('files', v_files, 'bytes', v_bytes));
  return v_header || jsonb_build_object(
    'export', v_export,
    'exported_at', now(),
    'exported_by', private.uid(),
    'files', v_files,
    'bytes', v_bytes);
end $$;

-- One thread's messages in this export, oldest first, after p_after.
create function public.export_messages(p_vault uuid, p_export uuid, p_thread uuid,
                                       p_after bigint default 0, p_limit int default 500)
returns table (id bigint, author uuid, agent text, at timestamptz, body text,
               redacted_at timestamptz, redacted_by uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_started boolean;
  v_last bigint;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners export a vault' using errcode = '42501';
  end if;
  select true, e.last_message_id into v_started, v_last from private.vault_exports e
   where e.id = p_export and e.vault_id = p_vault and e.started_by = private.uid()
     and e.started_at > now() - interval '2 hours';
  if v_started is null then
    raise exception 'this export has expired or was never started: start it again' using errcode = '55000';
  end if;
  return query
    select m.id, m.author, m.agent, m.at, m.body, m.redacted_at, m.redacted_by
      from public.thread_messages m
     where m.vault_id = p_vault and m.thread_id = p_thread
       and m.id <= v_last and m.id > coalesce(p_after, 0)
     order by m.id
     limit least(greatest(coalesce(p_limit, 500), 1), 500);
end $$;

revoke all on function public.export_messages(uuid, uuid, uuid, bigint, int) from public, anon;
grant execute on function public.export_messages(uuid, uuid, uuid, bigint, int) to authenticated;
