# Frontend deploy

Production frontend files are served directly by the host nginx on Server 5
(`175.178.13.169`). Production deploys do not build or run a frontend Docker
container.

## CI/CD

Run the manual workflow:

```bash
gh workflow run deploy-frontend.yml --ref <branch>
```

The workflow:

1. builds `frontend/dist` on GitHub Actions;
2. uploads a compressed static bundle to Server 5;
3. extracts it under
   `/var/lib/maimai-score-hub-web/frontend-releases/<commit>`;
4. atomically switches the `frontend-current` symlink;
5. validates host nginx and probes both public frontend hostnames locally.

The nginx document root is:

```text
/var/lib/maimai-score-hub-web/frontend-current
```

Old releases remain available for an immediate symlink rollback.

## Host nginx

Tracked host configuration lives under `backend/host-nginx/`. The host nginx
serves Frontend and Admin, terminates TLS for all public domains, and proxies
API traffic to the backend load balancer on `127.0.0.1:8090`.

The Docker-based `frontend/docker-compose.yml` and
`scripts/deploy-zero-downtime.sh` remain available for local or standalone
deployments; they are not used by production CI/CD.
