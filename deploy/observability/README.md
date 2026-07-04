# Observability deployment

This directory is the Phase 0 single-node deployment for
`docs/log-monitor-refactor`.

It runs on Server 4 / 101 under `/srv/maimai-observability`:

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

Windows dev backend can then use:

```text
OBSERVABILITY_ENABLED=true
OBSERVABILITY_ENV=dev
CLICKHOUSE_URL=http://192.168.1.101:8123
CLICKHOUSE_DATABASE=maimai_observability
CLICKHOUSE_USER=maimai_dev_writer
CLICKHOUSE_PASSWORD=<CLICKHOUSE_PASSWORD>
ARTIFACT_SERVICE_URL=http://192.168.1.101:3901
```
