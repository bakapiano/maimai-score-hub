# Cross-service E2E tests

This package owns tests that cross the Backend / Redis / MongoDB / standalone
`sdgb-worker` process boundary. Backend unit and Nest integration tests remain
under `backend/`; cross-service lifecycle tests belong here.

All sdgb tests use `SDGB_FAKE_UPSTREAM=1`. They never call the cabinet API.

## Default: local MongoDB and Redis

The default command connects to the native services used by local development:

```powershell
npm --prefix e2e install
npm run test:e2e:sdgb
```

Defaults are `127.0.0.1:27017` and `127.0.0.1:6379`. Values from
`.env.local-dev` are used for host, port and credentials. `E2E_MONGO_HOST`,
`E2E_MONGO_PORT`, `E2E_MONGO_USER`, `E2E_MONGO_PASSWORD`,
`E2E_MONGO_AUTH_SOURCE`, and the equivalent `E2E_REDIS_*` variables override
them. `E2E_MONGO_DB_PREFIX` changes the disposable database prefix; the unique
run token is always appended.

The harness starts its own Backend plus two Stable and two Recoverable fake
workers. Every run creates a unique Mongo database, Redis key prefix and BullMQ
prefix, then drops/deletes only those resources during teardown. It does not
flush the local Redis database or write test jobs into `maimai_web`.

Membership, recovery, and queue-repair timers are shortened in the spawned
test processes so failover safety paths complete in seconds. Production rate
and timing values remain covered by unit/config tests rather than this suite.

The standalone worker is expected at `../sdgb-worker`. To use another checkout:

```powershell
$env:SDGB_WORKER_DIR = 'D:\path\to\maimai-score-hub-sdgb-worker'
npm run test:e2e:sdgb
```

## Optional: Testcontainers

Container support is implemented for reproducible isolated infrastructure, but
it is opt-in and requires a running Docker daemon:

```powershell
npm run test:e2e:sdgb:containers
```

This starts `mongo:7` and `redis:7-alpine`; Backend and workers still run as
local Node processes. Override the images with `E2E_MONGO_IMAGE` and
`E2E_REDIS_IMAGE` if needed.

## Covered behavior

- correct-lane execution and wrong-lane rejection;
- active-active distribution across 2 Recoverable + 2 Stable workers;
- single-member loss without cross-class fallback;
- complete preferred-class loss, fallback, and preferred handback for both
  lanes;
- empty response, same-job retry, coverage gate, no-op recovery hook,
  verification, and handback;
- Stable production-rate root limiting and Interactive priority during Probe
  fallback;
- active Scan/Add/Music graceful shutdown with fake music cleanup;
- unauthorized membership and stale execution-token rejection.

The mock MaintenanceHook exercises the same `hookMayRun -> execute ->
hook-observation` contract and observation replay semantics. It does not invoke
router, cabinet, or cloud APIs.

Run one acceptance scenario while developing:

```powershell
$env:E2E_SCENARIO = 'fencing'
npm run test:local
```

No CI workflow is included. The package can be wired into CI later once Docker
and access to the private standalone worker repository are available there.
