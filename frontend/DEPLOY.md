# Frontend zero-downtime deploy

The frontend is a static Vite app served by a single nginx container. Recreating
that container drops the `8848:80` port briefly, so normal `docker compose up -d
--build` is not a zero-downtime deploy.

The standalone admin portal is served by a separate nginx container on
`127.0.0.1:8849` and is exposed publicly under `/admin/` by the frontend nginx
reverse proxy. Changes to `frontend/nginx.conf` still require a frontend
container rollout; admin-only UI changes use the admin deploy workflow.

Use `scripts/deploy-zero-downtime.sh` for regular frontend releases. It keeps
the current nginx container running, builds a candidate image, probes the
candidate on a temporary localhost port, then copies the built static files into
the running container:

1. hashed assets and secondary static files are copied first;
2. old hashed assets are kept so existing browser tabs can still load chunks;
3. `manifest.webmanifest`, `sw.js`, then `index.html` are replaced last with
   same-directory `mv`;
4. the public URL is probed after publish.

## First run

Start the service once if it is not already running:

```bash
docker compose -f frontend/docker-compose.yml up -d --build frontend
```

After that, deploy without recreating the container:

```bash
frontend/scripts/deploy-zero-downtime.sh
```

To print the deploy plan without touching Docker:

```bash
frontend/scripts/deploy-zero-downtime.sh --plan
```

If the service is absent and you intentionally want the script to start it:

```bash
frontend/scripts/deploy-zero-downtime.sh --bootstrap
```

`--bootstrap` is not a zero-downtime operation when no frontend is currently
serving; it only removes the manual first-start step.

## Side probe

Run the probe in a separate shell before starting a deploy:

```bash
frontend/scripts/probe-frontend-availability.sh \
  --url http://127.0.0.1:8848/ \
  --duration 90 \
  --interval-ms 100 \
  --log-file /tmp/frontend-deploy-probe.csv
```

In another shell:

```bash
frontend/scripts/deploy-zero-downtime.sh
```

The probe exits non-zero if any request times out or returns a non-2xx/3xx
status.

## Notes

- This flow is for static frontend releases. nginx config changes still require
  a separate, explicit nginx reload or container rollout.
- The `/admin/` reverse proxy lives in frontend nginx. Deploy `admin` for admin
  app changes, but deploy `frontend` when changing the proxy route itself.
- The script uses the existing Dockerfile for the build, so the candidate
  artifact matches the image-based deployment path.
- Because old hashed assets are retained, periodically prune very old files if
  the container writable layer grows too large.
