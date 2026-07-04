# Observability deployment

This directory is the single-node production deployment for
`docs/log-monitor-refactor`.

It runs on Server 5 under `/srv/maimai-observability`, next to the backend
host. The backend container reaches it through `host.docker.internal`:

- ClickHouse HTTP on `8123`
- ClickHouse native protocol on local-only `127.0.0.1:9000`
- artifact service on `3901`
- artifacts under `/srv/maimai-observability/artifacts`

Deploy:

```bash
cd /srv/maimai-observability
cp .env.example .env
# edit secrets
docker compose up -d --build
```

Production backend can then use:

```text
OBSERVABILITY_ENABLED=true
OBSERVABILITY_ENV=prod
CLICKHOUSE_URL=http://host.docker.internal:8123
CLICKHOUSE_DATABASE=maimai_observability
CLICKHOUSE_USER=maimai_dev_writer
CLICKHOUSE_PASSWORD=<CLICKHOUSE_PASSWORD>
ARTIFACT_SERVICE_URL=http://host.docker.internal:3901
```
