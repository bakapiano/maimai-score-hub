# Auto-update production capacity profile

Server 5 runtime configuration, 2026-11-25:

| Setting | Previous | Tuned |
| --- | ---: | ---: |
| `AUTO_UPDATE_RIVAL_CONCURRENCY` | 4 | 16 |
| `AUTO_UPDATE_MAP_CONCURRENCY` | 2 | 8 |
| `AUTO_UPDATE_RIVAL_BATCH_LIMIT` | 480 | 480 |
| `AUTO_UPDATE_MAP_BATCH_LIMIT` | 120 | 240 |

The host-only `backend/.env` selects this profile. Compose now forwards both
concurrency settings; application and Compose defaults remain conservative
(4/2 concurrency, 480/120 batches). Deployments preserve the runtime `.env`.
Credentials are not part of this document.

At inspection, the Recoverable worker had total concurrency 32 and Rival/Map
semaphores 16/16. The backend phases remain sequential, avoiding concurrent
Rival and Map writes to one user's state. Worker-side limits, Stable/Azure QPS
limits, per-user probe intervals, leases and 60-second admission budgets are
unchanged. This is capacity tuning, not a bypass of the worker safety limits.

Before tuning, approximately 4,807 enabled users required 9,362 Rival and
5,349 Map probes/hour at the configured tiers. Observed throughput was about
2,962 and 1,558/hour. Individual probes averaged 1.6 seconds; most delay was
waiting for backend admission. The low-concurrency phases each consumed
60 seconds, and the next cron minute made a sweep start every three minutes.

At an unchanged 1.6-second average, the tuned profile can finish 480 Rival
and 240 Map probes in approximately 96 seconds, fitting a two-minute cron
cadence. This is a planning estimate, not guaranteed capacity: verify actual
phase durations, completed/failed counts, due backlog age, worker queue
latency and resource usage across several real sweeps. Do not remove the
budgets or raise concurrency past worker capacity to hide slow execution.

For a runtime-only rollout, back up `.env` and Compose first, render and
validate the selected non-secret values, then roll one backend replica at a
time with the existing image. Never recreate Mongo, Redis or nginx for this
change. Keep at least two healthy backend replicas until a new replica is
healthy, then remove only the explicitly identified old replica. Rollback
uses the preserved image and settings through the same rolling sequence.

## Production acceptance (2026-11-25, Asia/Shanghai)

The runtime-only rolling update completed at 21:10:05 using the existing
application image/revision `59b63e8`. Both replicas were healthy; each was
checked for 16/8 concurrency and 480/240 batches before replacing its old
counterpart. Neither the workers nor stateful dependencies were restarted.

The 21:11 and 21:13 sweeps each completed all 480 Rival and 240 Map probes
with zero failures, finishing at 21:12:47 and 21:14:47 (about 107 seconds).
This establishes a two-minute cadence in the observation window, equivalent
to approximately 14,400 Rival and 7,200 Map probes/hour if sustained; these
are extrapolations, not measured hour-long totals. At 21:14:46, mean observed
durations were 1.80s Rival and 1.61s Map, with no failed probes since rollout.
Due counts fell from 3,157/3,418 at 21:10:59 to 2,437/3,022 at 21:14:46.
The old backlog was still draining, so per-user target intervals had not yet
been fully revalidated. Local and GitHub regression checks passed 40 tests.

Host-only rollback files remain under
`/root/maimai-backend-capacity-before-20261125.ECRtFoVl/`.
