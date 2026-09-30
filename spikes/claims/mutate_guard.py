import re, sys
name = sys.argv[1]
s = open('guard.sql').read()
def rep(old, new, count=1):
    global s
    assert s.count(old) >= 1, (name, old[:70])
    s = s.replace(old, new, count)
if name == 'no-hoard-cap':      rep("if v_conn >= r.max_active or v_person >= r.max_active_member then", "if false then")
elif name == 'no-person-cap':   rep(" or v_person >= r.max_active_member", "")
elif name == 'no-connection-check': rep("     and holder_token = nullif(current_setting('app.token', true), '')::uuid\n     and holder_member = v_member\n", "     and holder_member = v_member\n")
elif name == 'public-execute':  rep("revoke execute on all functions in schema public from public;", "")
elif name == 'table-grant':     rep("grant usage on schema public to agent_api;", "grant usage on schema public to agent_api;\ngrant all on all tables in schema public to agent_api;")
elif name == 'no-fast-path':    rep("if found and tk.next_allowed_at > v_now then", "if false then")
elif name == 'no-max-hold':
    rep("least(clock_timestamp() + r.lease, s.claimed_at + r.max_hold)", "clock_timestamp() + r.lease")
    rep("and s.claimed_at + r.max_hold > clock_timestamp()", "")
elif name == 'no-ticket-cap':   rep("if v_live >= r.max_tickets then", "if false then")
elif name == 'no-fairness':     rep("if v_rank <= v_ready then", "if v_ready > 0 then")
elif name == 'no-blocker-gate':
    s, n = re.subn(r"s\.open_blockers = 0", "true", s); assert n >= 3, n
elif name == 'no-counter-decrement':
    rep("  update plan_steps s set open_blockers = s.open_blockers - 1\n   where s.id in (select d.step_id from plan_step_deps d where d.blocker_id = p_id);", "")
elif name == 'no-strikes':      rep("from pick where pick.prev_status = 'claimed' and pick.prev_member is not null", "from pick where false")
elif name == 'no-cooldown':     rep("if v_cool is not null and v_cool > v_now then", "if false then")
elif name == 'no-strike-reset': rep("  delete from claim_strikes where vault_id = v_vault and member = v_member;", "")
elif name == 'places-by-token': rep("on conflict (vault_id, plan, member) do update", "on conflict (vault_id, plan, holder_token) do update")
else: raise SystemExit("unknown " + name)
open('guard_mutant.sql', 'w').write(s)
