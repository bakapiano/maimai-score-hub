# Admin deploy

The Admin Vite app is built with `base: "/admin/"` and is served directly by
the host nginx on Server 5 (`175.178.13.169`). It does not use a production
Docker container.

## CI/CD

Run the manual workflow:

```bash
gh workflow run deploy-admin.yml --ref <branch>
```

The workflow:

1. builds `admin/dist` on GitHub Actions;
2. uploads the compressed static bundle to Server 5;
3. extracts it under
   `/var/lib/maimai-score-hub-web/admin-releases/<commit>/admin`;
4. atomically switches the `admin-current` symlink;
5. validates `/admin/` through both public frontend hostnames.

The nginx document root for Admin is:

```text
/var/lib/maimai-score-hub-web/admin-current
```

Old releases remain available for an immediate symlink rollback. The
Docker-based `admin/docker-compose.yml` remains for local or standalone use
only.
