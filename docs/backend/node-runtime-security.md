# Node runtime security baseline

The 2026-10-23 runtime update pins production and CI builds to Node 22.23.4.
It includes the CVE-2026-111497 Brotli decoder fix and the other fixes in the
October Node security release.

The Node release backports Brotli commit `0ed4268a4401abcb44720963`; its
`process.versions.brotli` string remains `1.1.0`. Verify the Node patch release
and the exported `BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH` constant when
checking deployed containers. Runtime Docker builds enforce this marker.

```sh
node -p 'JSON.stringify({node:process.versions.node,brotli:process.versions.brotli,blockSwitchError:require("node:zlib").constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH})'
```

The expected Node 22 baseline is `22.23.4` or a newer patched 22.x release;
the block-switch error constant is `-17`. Other maintained release lines
must include their corresponding security release (24.22.1 or 26.12.1).

Backend, DXNet, and the observability artifact service use the monorepo's
manual deployment workflows. The separately tracked SDGB worker has its own
runtime/CI pins and deployment workflow. Frontend/Admin image changes affect
their build stage; production serves their existing static bundles via nginx.

Reference: https://nodejs.org/en/blog/release/v22.23.4
