# maimai Score Hub Admin

Standalone admin frontend. It reuses the shared API contracts from `../shared`
and proxies `/api` to the local backend in development. In production it is
served under `/admin/` by its own nginx container on port `8849`; the public
`maimai.bakapiano.com/admin/` and `maiscorehub.bakapiano.com/admin/` routes are
proxied through the main frontend nginx.

```bash
npm --prefix admin install
npm --prefix admin run dev
```

The dev server listens on `http://127.0.0.1:3002`.
