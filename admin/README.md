# maimai Score Hub Admin

Standalone admin frontend. It reuses the shared API contracts from `../shared`
and proxies `/api` to the local backend in development.

```bash
npm --prefix admin install
npm --prefix admin run dev
```

The dev server listens on `http://127.0.0.1:3002`.
