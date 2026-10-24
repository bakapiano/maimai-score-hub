# Opt-in SVG profile cards

Only SVG is exposed. No worker or score-sync job is started by card requests.

## Routes

- Authenticated: GET/POST/PATCH/DELETE `/api/v1/me/stats-card`;
  POST `/api/v1/me/stats-card/rotate`; GET `/api/v1/me/stats-card/preview.svg`.
- Public: GET/HEAD `/api/v1/stats/:code/card.svg?theme=light|dark`.
- Host nginx and Vite alias `/stats/:code/card.svg` to that public API.
- POST bodies must be `{}`. Ownership comes from the verified JWT subject,
  never from a supplied friend code/user ID.

Preview does not create a share or a persisted image. Enabling creates a
192-bit random, URL-safe code; repeated enable requests keep the current code.
Disabling clears it; re-enabling and rotating issue new codes.

Owner-only PATCH accepts one or more boolean visibility fields: `rating`,
`awakeningCount`, `classRank` (友人对战段位), `courseRank` (课题段位), and `title`.
These default to true for both new and pre-feature records. Saving settings
before enabling creates only a disabled configuration row, not a public code.
Settings survive reopening, rotation and disable/re-enable. Updates preserve
the URL but increment its generation and invalidate previous artifacts.
Hidden values and asset URLs are removed before fetching assets or rendering
private previews/public SVGs. Public query parameters cannot override them.
The settings UI is the first card under website settings, and its modal is
full-screen on mobile. The five switches autosave; only the image URL is copied.

## Persistence and bounded caches

- `stats_card_shares`: one row per account, unique non-null code; current
  enabled state and generation are authoritative.
- `stats_card_artifacts`: unique `(shareId, theme)`; gzip BSON binary, ETag,
  content hash, renderer version and CAS revision. At most two latest
  artifacts per share, not one row per score update.
- Per process: at most 32 MiB / 1,024 entries of compressed SVG payload,
  ten-minute expiry; normalized assets have a separate 8 MiB / 256-entry,
  24-hour cache. Metadata/native rendering buffers and fonts are additional.
- At most four render tasks per process; identical concurrent requests share
  one promise. At most twelve outbound asset fetches per process.
- SVG output is capped at 256 KiB. Text is bounded and fitted, raster inputs
  are capped at 1 MiB / 1 megapixel, resized and re-encoded without metadata.
- No finished SVGs are put in the BullMQ Redis instance.

Each public request checks the current share/account before the hot cache,
and checks again before returning an image or 304. Cached data never grants
permission. Changes to public profile fields, theme, normalized asset bytes
or the renderer version select a different cache entry. Artifacts
are replaced with compare-and-swap, so an in-flight renderer cannot clobber
another writer's revision. Share generation fences rotation/disable/visibility races.
Account deletion removes both collections' corresponding rows.

Responses use `Cache-Control: public, no-cache`, weak ETags and
`Vary: Accept-Encoding`. Gzip is served when accepted. Private previews and
errors use `no-store`. Nginx does not proxy-cache these routes; the frontend
service worker bypasses them. Third-party image proxies and previously saved
copies cannot be recalled, and already in-flight responses may finish.

## Rendering/security

The renderer consumes an explicit public projection: nickname, title, rating,
avatar, course/class badges and awakening count. It does not serialize user
documents. The fixed 560×150 layout matches the desktop ProfileCard at the
same width (20px padding, 108px avatar, 160px title, 36px rank row). Typography
uses the exact shared system-font stack and weights from the frontend, not
the rounded B50 export font. SVG text is XML-escaped and clipped; no external
fonts are loaded. Appearance can vary with the viewer's OS just like the web
card. Images are embedded data URLs. There are no scripts, external image
references or foreignObject. Small embeds scale this desktop layout rather
than applying the frontend's mobile breakpoint.

Course/class ranks use the profile's original images; stars use the original
`icon_star.png`, not a drawn substitute. Exact-path local files under
`backend/assets/maimai-mobile/img/` are preferred; missing files use the
official origin and then the public site's `/maimai-mobile/img/` proxy.
Only HTTPS static PNG/JPEG paths under
`maimai.wahlap.com/maimai-mobile/img/` or the fixed
`maiscorehub.bakapiano.com/maimai-mobile/img/` fallback are fetched. Credentials, query strings,
alternate origins and redirects are rejected. Failures use a placeholder,
with a short bounded negative cache. Future asset origins must be reviewed,
not accepted from query parameters.

## Local checks

From `backend/`:

```sh
npm run build
node node_modules/jest/bin/jest.js --runInBand stats-card
npm run test:e2e:stats-card
```

With the local Vite frontend running, `node test/stats-card.visual.mjs` compares
the actual React component against the SVG at the same 560px width in both
themes. It checks element geometry within 0.05px and screenshot differences,
saving paired images under `.local-dev/stats-card-visual/`. Set
`STATS_CARD_VISUAL_VARIANT=long` or `empty` for the other fixtures. The SVG is
a static frame: overflowing titles are clipped, not animated like the webpage.

The E2E runner needs loopback MongoDB and a local Chromium and Redis/Memurai
binary. It starts two real backends, Vite and a private Redis port, seeds
synthetic accounts into a random `msh_stats_card_e2e_*` database, exercises
the browser UI and APIs, then stops its processes and drops only that exact
test database. Logs/screenshots/SVGs remain in ignored
`.local-dev/stats-card-e2e/<run-id>/`.

Optional overrides: `STATS_CARD_E2E_BROWSER`, `STATS_CARD_E2E_REDIS_BIN`,
`STATS_CARD_E2E_MONGO_PORT`, `STATS_CARD_E2E_MONGO_USER`,
`STATS_CARD_E2E_MONGO_PASSWORD`. Mongo credentials otherwise come from the
host-only `.env.local-dev`; Mongo's hostname remains hardcoded to loopback.
No production deploy is part of this test.
