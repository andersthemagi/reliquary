# Claims, waiting and work plans: reference spike

Research, not product code, like the other folders under `spikes/`. A throwaway
PostgreSQL 16 model of the design in the claims tracking issue, built to find out
whether it holds before anyone writes the real thing. Nothing here touches
Reliquary's schema, and the identity it uses is simulated with session settings.

## Run it

Needs PostgreSQL 16 server binaries and `pgbench`. Nothing else, and it never
touches a real database: `scratch-server.sh` starts a throwaway server on port
54329 with `fsync` off.

```bash
./scratch-server.sh start
./run-all.sh              # every edge-case and adversary suite, about 30 seconds
./mutation-check.sh       # removes each guard in turn; every one must fail a test
./scratch-server.sh stop
```

The stress and load scripts are separate: `run.sh`, `chaos.sh`, `plan_chaos.sh`,
`queue_compare.sh`, `scale_cost.sql`, `scale_load.sh`, `mixed.sh` and
`multi_vault.sh`. Each has its usage in the first lines.

## What it built, in order

1. An atomic claim on a path or a task: one conditional statement decides the
   race, the database clock decides expiry, a fence counter and a secret stop a
   stale holder.
2. Dependency-gated steps: a step is claimable only when everything blocking it is
   done, checked in the same statement as the claim.
3. Claim rules (a 48 hour default, overridable by path prefix, restarted by every
   check-in) and waiting: an agent that finds nothing to do takes a place in line
   and is told when to come back.
4. A design that assumes the agent is hostile: one way in, identity from the
   session, every rule a predicate in the same statement as the change, a
   read-only fast path for early callers, and caps and an escalating cooldown per
   person.
5. Thousands of vaults at once.

## Results

One machine, four cores, no network.

- Atomic claim: 10,000 contended attempts on 200 paths gave exactly 200 grants; a
  read-then-write version handed out 14 to 40 duplicates.
- Dependency gate: a 120-step plan under crashes had 0 claims past an unfinished
  blocker; with the gate deleted, 221.
- Waiting: following the suggested time made about 25 times fewer calls with
  abandoned claims and about 11 times fewer without, at a cost of 0.5 s on a 1 s
  plan.
- Hostile agents: 100 agents asking as fast as they can, 53,992 calls a second at
  1.9 ms with 200 ticket writes, against 6,172 at 16 ms and 92,239 writes for the
  first design. At 500 agents, 38,236 against 2,736 calls a second. 70
  assertions in 15 groups; 15 of 15 removed guards caught.
- A hostile crowd of 100 connections run by 5 people next to 20 honest agents on
  a 40-step plan: 24 of 40 steps after 90 s with guards by connection, 40 of 40 in
  16.6 s with guards by person (7.7 s with no crowd).
- Many vaults: 50,000 agents over 5,000 vaults, 24,036 calls a second at 8.3 ms,
  no errors. It also found a race: two requests at once from one connection could
  fail on a leftover unique constraint.

## What it does not show

- The hosted path: the MCP server, the serverless functions and the
  transaction-mode pooler. At the existing limit of 120 tool calls a minute per
  token, 100 hostile connections are about 200 calls a second, roughly 1,300
  pooler round trips a second, and that is where a limit would show.
- RLS, and this project's own tables. The agent role here stands in for the API
  role.
- Real agents. Whether they follow the suggested time is what a pilot measures.
- A first-time cost of a well-behaved fleet is agents divided by the gap between
  calls: 50,000 agents at 15 minutes is about 56 calls a second, at 15 seconds
  about 3,300. The gap is the lever.

Numbers vary by about a third from run to run on the first design; read them as
an order of magnitude.
