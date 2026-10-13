-- A vault no longer decides whether members' emails show (owner,
-- 2026-10-13: "The vault has no control over display preferences of the
-- user. That keeps it the simplest possible."). Fixes forward
-- 20261014150000_display_preferences.sql: its vault requirement, the
-- per-vault consent and the notice that asked for it go. What stays is the
-- person's own choice and the rule, now:
--
--   private.email_hidden(person): an agent never gets an email; a person
--   sees someone's email unless that someone chose display name alone;
--   you always see your own.
--
-- Old vault.require_emails log rows stay as they are (the log is
-- append-only); the web app keeps a label for them.

create or replace function private.email_hidden(p_person uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.agent() is not null
      or (p_person is distinct from private.uid()
          and exists (select 1 from public.display_preferences d where d.user_id = p_person and not d.show_email))
$$;

drop function public.consent_to_show_email(uuid);
drop function public.email_consent_needed(uuid);
drop function public.set_require_emails(uuid, boolean);
drop table public.email_consents;
alter table public.vaults drop column require_emails;
