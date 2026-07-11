# Admin deploy

The admin portal is a standalone Vite app served by its own nginx container.
It is built with `base: "/admin/"`, so all static assets are requested under
`/admin/assets/...`.

## Runtime

- Container: `admin`
- Compose file: `admin/docker-compose.yml`
- Host port: `127.0.0.1:8849` / `8849:80`
- Shared proxy network: external Docker network `maimai-web`
- Health check: `http://127.0.0.1:8849/admin/`
- Public routes: `maimai.bakapiano.com/admin/` and
  `maiscorehub.bakapiano.com/admin/`

The public route is not exposed directly by the admin container. It is proxied
by the main frontend nginx (`frontend/nginx.conf`) from `/admin/` to the admin
container name (`admin:80`) on the shared Docker network.

## CI/CD

Use the manual workflow:

```bash
gh workflow run deploy-admin.yml --ref <branch>
```

The workflow builds `admin/dist` on GitHub Actions and uploads the runtime
bundle to the Server 2 web deploy path shared with the main frontend. The
target host only builds the lightweight nginx runtime image, then runs:

```bash
docker compose -f admin/docker-compose.yml up -d --build admin
```

If the `/admin/` reverse-proxy route changes, deploy the main frontend first so
the Server 2 frontend nginx config is updated, then deploy admin.
