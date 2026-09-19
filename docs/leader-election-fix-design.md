# Design note — Auto Terminologist leader election (race fix)

Status: **design only, not implemented.** Follow-up task for the coder role.

## The bug

`src/hooks/useAutoTerminologist.ts` elects a leader tab via `tryAcquireLeader()` (lines ~58–72):

```
const raw = localStorage.getItem(LEADER_KEY);   // read
... lease check ...
localStorage.setItem(LEADER_KEY, ...);          // write
```

Read-then-write is not atomic, and `localStorage` is per-origin-per-browser, not per-deployment. Two tabs that tick
inside the same event-loop window both read a stale/expired lease and both write themselves as leader.

`tick()` compounds it: `getLastRunAt()` → compare against `RUN_INTERVAL_MS` → insert heartbeat is a second
check-then-act, `await`-separated, so two "leaders" both see the same stale `run_at` and both enter
`runAutoTerminologistCycle()`. Result: duplicate `custom_value_sets` drafts / double-merges, duplicate log rows.
`localStorage` also cannot coordinate across browsers, devices, or the other two deployed domains.

## Proposed fix — atomic DB-backed lease

Move the claim into Postgres, where a single `UPDATE` row-lock makes it atomic. Replace `tryAcquireLeader()` +
the `getLastRunAt()` gate with **one** claim call.

New single-row table `automation_leases` (reusable by `useAutomationWatchdog`, keyed by engine):

| column | notes |
|---|---|
| `engine` | PK, e.g. `'auto_terminologist'` |
| `holder` | text, the tab's `TAB_ID` |
| `leased_until` | timestamptz — lease TTL |
| `last_run_at` | timestamptz — replaces the `auto_terminologist_log` max scan |

`SECURITY DEFINER` function `claim_automation_lease(engine, holder, lease_ms, min_interval_ms)`:

```sql
UPDATE automation_leases
   SET holder = _holder,
       leased_until = now() + (_lease_ms || ' ms')::interval,
       last_run_at  = now()
 WHERE engine = _engine
   AND leased_until < now()                                  -- no live holder
   AND last_run_at < now() - (_min_interval_ms||' ms')::interval  -- cadence gate
RETURNING *;
```

Zero rows returned = another tab holds the lease or the interval hasn't elapsed → `return`. One row = this tab owns
the cycle. The `WHERE` predicate and the `SET` execute under the same row lock, so exactly one concurrent caller
wins. `last_run_at` advances at claim time, preserving today's "heartbeat first, never drift" behaviour.

Lease TTL: keep `3 min` (`LEADER_LEASE_MS`), but **renew** it mid-cycle (a `heartbeat_automation_lease` call every
~30s from the running cycle) so a long cycle can't have its lease stolen, while a crashed tab still frees it within
one TTL. Best-effort release in the `useEffect` cleanup, purely as an optimisation.

Seed one row per engine in the migration. RLS: allow the anon/authenticated role to `EXECUTE` the functions only —
no direct table writes.

## Out of scope

Removing `LEADER_KEY`/`TAB_ID` localStorage entirely, and applying the same lease to `useAutomationWatchdog`, are
the natural second and third commits.
