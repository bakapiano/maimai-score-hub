# Local Dev Environment

This project can run locally on Windows without Docker or WSL. The recommended setup is:

- MongoDB as a native Windows service
- Redis-compatible Memurai as a native Windows process
- backend / frontend / worker started with npm, VS Code tasks, or the PM2
  local-dev supervisor

## Current Windows machine

### MongoDB

MongoDB is already installed and running as a Windows service:

```text
Service: MongoDB
Status: Running
Binary: D:\MongoDB\bin\mongod.exe
Endpoint: 127.0.0.1:27017
```

Verify:

```powershell
Test-NetConnection 127.0.0.1 -Port 27017
```

### Redis

Redis is provided by Memurai Developer portable, installed by Chocolatey:

```text
Package: memurai-developer.portable 4.1.8
Binary: C:\ProgramData\chocolatey\bin\memurai.exe
CLI: C:\ProgramData\chocolatey\bin\memurai-cli.exe
Endpoint: 127.0.0.1:6379
```

This portable install is not registered as a Windows service. Start it manually when needed:

```powershell
C:\ProgramData\chocolatey\bin\memurai.exe --port 6379 --dir C:\ProgramData\MemuraiDev
```

Verify:

```powershell
Test-NetConnection 127.0.0.1 -Port 6379
C:\ProgramData\chocolatey\bin\memurai-cli.exe -h 127.0.0.1 -p 6379 ping
```

The `ping` command should return:

```text
PONG
```

## One-command local dev with PM2

The repo includes a PM2-based local dev supervisor. It starts:

- Memurai on `127.0.0.1:6379`
- backend on `127.0.0.1:9050`
- frontend on `127.0.0.1:3001`
- DXNet worker (`msh-worker`) connected to local backend/Redis
- sdgb-worker (`msh-sdgb-worker`) connected to local backend/Redis
- Microsoft Dev Tunnel for frontend public access

First-time setup:

```powershell
cd D:\maimaidx-prober-proxy-updater
Copy-Item .env.local-dev.example .env.local-dev
```

Edit `.env.local-dev`:

- Set `ADMIN_PASSWORD` / `API_SHARED_SECRET`.
- Set `CLICKHOUSE_PASSWORD` to the 101 ClickHouse writer password.

Start everything:

```powershell
npm run dev:local:start
```

Check status:

```powershell
npm run dev:local:status
```

Show logs:

```powershell
npm run dev:local:logs
npm run dev:local:logs -- msh-backend
npm run dev:local:logs -- msh-devtunnel
```

Stop everything managed by the supervisor:

```powershell
npm run dev:local:stop
```

Notes:

- `start-local.ps1` builds `shared` and `backend` once, then starts backend
  from `backend/dist/main.js`. This avoids repeatedly triggering
  `prestart -> openapi:generate` just to boot local dev.
- `sdgb-worker\` is still untracked and secret-bearing. The supervisor starts it
  only if the directory and its dependencies exist on this machine.
- The scripts only stop PM2-managed processes. They do not kill unrelated
  `node.exe` processes by name.
- Dev Tunnel URL is printed in `msh-devtunnel` logs.

## Manual backend `.env`

Create or update `backend\.env`:

```env
PORT=9050

MONGO_HOST=127.0.0.1
MONGO_PORT=27017
MONGO_DB=maimai_web

# Leave empty if local MongoDB has no auth enabled.
MONGO_USER=
MONGO_PASSWORD=
MONGO_AUTH_SOURCE=admin

REDIS_URL=
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=
REDIS_KEY_PREFIX=maimai:
BULLMQ_PREFIX=

AUTH_JWT_SECRET=change-me-local
ADMIN_PASSWORD=
SKIP_AUTH=true
```

If the local MongoDB restore uses an authenticated user, set `MONGO_USER`,
`MONGO_PASSWORD`, and `MONGO_AUTH_SOURCE` accordingly.

## DXNet worker `.env`

Create or update `worker\.env`:

```env
NODE_ENV=dev

JOB_SERVICE_BASE_URL=http://127.0.0.1:9050/

REDIS_URL=
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=
REDIS_KEY_PREFIX=maimai:
BULLMQ_PREFIX=
```

The backend and worker must use the same Redis instance and the same
`REDIS_KEY_PREFIX` / `BULLMQ_PREFIX`, otherwise queued DXNet jobs will not be
picked up by the worker.

## sdgb-worker `.env`

The top-level `sdgb-worker\` directory is intentionally untracked because it
contains cabinet protocol configuration. For local startup, make sure
`sdgb-worker\.env` points at the local backend and Redis:

```env
BACKEND_URL=http://127.0.0.1:9050
WORKER_ID=sdgb-worker-local-dev

REDIS_URL=
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=
REDIS_KEY_PREFIX=maimai:
BULLMQ_PREFIX=
```

## Start services

Build shared first:

```powershell
cd D:\maimaidx-prober-proxy-updater\shared
npm run build
```

Then start the services in separate terminals:

```powershell
cd D:\maimaidx-prober-proxy-updater\backend
npm run start:dev
```

```powershell
cd D:\maimaidx-prober-proxy-updater\frontend
npm run dev
```

```powershell
cd D:\maimaidx-prober-proxy-updater\worker
npm run start:dev
```

```powershell
cd D:\maimaidx-prober-proxy-updater\sdgb-worker
npm run start:dev
```

Alternatively, use the VS Code `dev:all` task after MongoDB and Memurai are
running.

## Docker Compose note

`backend\docker-compose.yml` is for deployed backend infrastructure. It now
includes MongoDB, Redis, backend, and nginx. For local Windows npm-based
development, prefer the native MongoDB service and Memurai process described
above.
