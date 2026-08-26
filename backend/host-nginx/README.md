# Server 5 host nginx

Server 5 (`175.178.13.169`) terminates TLS and serves all public web traffic
with the OS nginx service. The backend application remains in Docker behind
`127.0.0.1:8090`.

## Paths

- nginx configuration: `/etc/nginx/nginx.conf`, `/etc/nginx/conf.d/msh.conf`
- nginx snippets: `/etc/nginx/snippets/msh-*.conf`
- frontend releases: `/var/lib/maimai-score-hub-web/frontend-releases/`
- admin releases: `/var/lib/maimai-score-hub-web/admin-releases/`
- ACME webroot: `/var/lib/maimai-score-hub/acme/`
- certificates: `/etc/maimai-score-hub/tls/<domain>/`

`frontend-current` and `admin-current` are atomically replaced symlinks. The
Frontend and Admin GitHub Actions workflows build on GitHub-hosted runners and
only upload static release archives to Server 5.

Frontend activation merges the content-hashed assets from the five most recent
releases into the incoming release. This compatibility window lets already-open
WebViews finish lazy imports while `index.html` and SPA routes use no-cache
headers to discover the new entry bundle.

`deploy-backend.yml` installs the tracked `msh.conf`, proxy parameters and web
location snippet into `/etc/nginx`, validates them with `nginx -t`, then reloads
the host service after a successful Backend rollout.

## Compression

The host uses the OpenCloudOS nginx 1.26.3 package with gzip and the official
`google/ngx_brotli` dynamic modules:

- `ngx_brotli`: `a71f9312c2deb28875acc7bacfdd5695a111aa53`
- Brotli dependency: `ed738e842d2fbdf2d6459e39267a633c4a9b2f5d`

The modules are installed at:

```text
/usr/lib64/nginx/modules/ngx_http_brotli_filter_module.so
/usr/lib64/nginx/modules/ngx_http_brotli_static_module.so
```

and loaded by `/usr/share/nginx/modules/50-mod-http-brotli.conf`.

## Certificates

`acme.sh` issues separate ECDSA certificates for:

- `api.maiscorehub.bakapiano.com`
- `maiscorehub.bakapiano.com`
- `maimai.bakapiano.com`

The root crontab runs `acme.sh --cron` four times daily. Each installed
certificate uses `nginx -t && systemctl reload nginx` as its reload command.

## Validation

```bash
nginx -t
systemctl is-active nginx
curl -fsS https://api.maiscorehub.bakapiano.com/api/v1/health
curl -fsS https://maiscorehub.bakapiano.com/ >/dev/null
curl -fsS https://maiscorehub.bakapiano.com/admin/ >/dev/null
curl -sSI -H 'Accept-Encoding: br' \
  https://maiscorehub.bakapiano.com/assets/<asset>.js
```
