# CDN 静态资源与公共目录加速架构

本文档记录 `maimai Score Hub` 的 Alibaba Cloud CDN 源站回源（Origin-Pull）加速架构、流量分流边界、缓存策略、TLS 自动续签与运维手册。

---

## 1. 架构总览

生产源站部署在 Server 5（腾讯云轻量应用服务器，5 Mbps 公网带宽，主机名 `maiscorehub.bakapiano.com`）。由于首屏封面墙（50+ 张曲绘）、曲库 JSON（~1.2 MB 原始体积）与前端构建产物并发下载容易打满源站 5 Mbps 出口带宽，我们引入独立静态加速域名 `cdn.maiscorehub.bakapiano.com` 承担可公开缓存的静态资源与公共目录流量。

```
Browser
  ├─ https://maiscorehub.bakapiano.com  (Direct Origin → Server 5 Host Nginx)
  │    ├─ /, SPA routes (index.html, no-cache)
  │    ├─ /sw.js, /manifest.webmanifest, /favicon.png, /pwa-*.png
  │    ├─ /stats/*  (revocable SVG cards)
  │    └─ /api/v1/{auth,me,jobs,scores,admin,...}/*  (dynamic & authenticated APIs)
  │
  └─ https://cdn.maiscorehub.bakapiano.com  (Alibaba Cloud CDN, CN Domestic)
       │  CNAME: cdn.maiscorehub.bakapiano.com.w.kunlunaq.com
       │  Origin-Pull: HTTPS :443, Host: maiscorehub.bakapiano.com
       ├─ /assets/*.js, /assets/*.css           (Vite hashed chunks, 1y immutable)
       ├─ /mai/pic/*, /favicon.webp             (static UI images, 7d)
       ├─ /api/v1/catalog/covers/:id?...        (song covers, 200x200 WebP thumb, 1y)
       ├─ /maimai-mobile/img/*                  (Wahlap avatars & badges via origin cache, 30d)
       └─ /api/v1/catalog/music[,/aliases]      (public music catalog & aliases, 30m)
```

### 设计原则

1. **HTML 入口与动态 API 留源站**：`index.html`、`sw.js`、`manifest.webmanifest` 始终直连源站，确保前端发布后秒级生效、Service Worker 作用域同源，且无需在每次发版后手动刷新 CDN HTML 缓存；所有带鉴权或写操作的 API 保持同源直连，避免额外 CDN 回源延迟、CORS 预检和动态流量计费。
2. **源站回源（Origin-Pull），不引入额外对象存储同步**：曲绘由后端按需从外部源动态抓取并落盘，华立头像/段位图由源站 Nginx 代理并做本地磁盘缓存（`msh_image_cache`）。CDN 首次未命中时回源 `maiscorehub.bakapiano.com` 拉取一次，后续全国边缘节点直接命中缓存，源站几乎零带宽压力。
3. **显式 URL 版本/格式参数避免 `Vary` 缓存碎片**：曲绘请求固定携带 `?v=4&format=webp&size=thumb`，后端在检测到显式 `format` 参数时不返回 `Vary: Accept`，确保所有浏览器共享同一份 CDN 边缘缓存副本。

---

## 2. 流量分流明细

| 资源类型 | 走 CDN 还是源站 | 路径 / 示例 | 浏览器 TTL | CDN 边缘 TTL | 说明 |
|---|---|---|---|---|---|
| SPA 入口与 PWA 元数据 | 源站直连 | `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest` | `no-cache` | — | 发布即生效，SW 同源作用域 |
| 前端 JS/CSS 构建产物 | **CDN** | `/assets/*.js`, `/assets/*.css` | `1y, immutable` | `365d` | 内容哈希命名，由 Vite `renderBuiltUrl` 自动改写 |
| 曲绘缩略图（列表/B50） | **CDN** | `/api/v1/catalog/covers/:id?v=4&format=webp&size=thumb` | `1y, immutable` | `365d` | 200×200 WebP q75，源站按需生成并落盘 `<id>.thumb.webp` |
| 曲绘原图（兜底/旧客户端） | **CDN** / 源站 | `/api/v1/catalog/covers/:id?v=3` | `1y, immutable` | `365d` | 400×400 WebP/PNG，无 `format` 时保留 `Vary: Accept` 兼容旧端 |
| 华立头像 / 段位 / 图标 | **CDN** | `/maimai-mobile/img/*` | `30d` | `30d` | 源站 Nginx `msh_image_cache` 缓存 30d + CDN 边缘缓存 30d |
| 公共静态图 | **CDN** | `/mai/pic/*`, `/favicon.webp` | `7d` | `7d` | 站点内引用（AppHeader、AboutPage、ScoreCard 图标等） |
| 曲库与别名 JSON | **CDN** | `/api/v1/catalog/music`, `/api/v1/catalog/music/aliases` | `10m` | `30m` | 带 `stale-while-revalidate=3600`，源站 Nginx 同步缓存 30m |
| 用户分享卡片 SVG | 源站直连 | `/stats/*` | 按源站策略 | — | 支持用户立即撤销/更换 token，不走长期 CDN 缓存 |
| 动态与鉴权 API | 源站直连 | `/api/v1/auth/*`, `/api/v1/me/*`, `/api/v1/jobs/*` 等 | `no-store` / 动态 | — | 同源请求，无预检，实时一致 |

---

## 3. CDN 边缘配置（Alibaba Cloud CDN）

- **加速域名**：`cdn.maiscorehub.bakapiano.com`
- **CNAME 目标**：`cdn.maiscorehub.bakapiano.com.w.kunlunaq.com`
- **业务类型 / 加速区域**：图片小文件 / 网页加速（`web`），中国内地（`domestic`）
- **回源配置**：
  - 源站地址：`maiscorehub.bakapiano.com:443`
  - 回源 Host：`maiscorehub.bakapiano.com`（`set_req_host_header`）
  - 回源协议：强制 HTTPS（`forward_scheme=https`）
- **传输与安全**：
  - HTTPS 证书：Let's Encrypt RSA-2048，由 Server 5 `acme.sh` 自动续签并部署
  - 强制 HTTPS 跳转：`https_force=on`
  - HTTP/2 + OCSP Stapling：`https_option` (`http2=on`, `ocsp_stapling=on`)
  - 压缩：`gzip=on`，`brotli=on`（level 6）
- **跨域响应头（CORS）**：
  - `Access-Control-Allow-Origin: *`
  - `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
  - （ES Module `<script type="module" crossorigin>`、`fetch` 拉取曲库 JSON、Canvas 导出图片均依赖此配置）
- **边缘缓存规则**：
  - 路径 `/api/v1/catalog/covers`：`31536000s`（1 年）
  - 路径 `/assets`：`31536000s`（1 年）
  - 路径 `/maimai-mobile/img`：`2592000s`（30 天）
  - 路径 `/api/v1/catalog/music`：`1800s`（30 分钟）
  - 文件类型 `png,webp,jpg,jpeg,svg,ico,woff,woff2`：`604800s`（7 天）

---

## 4. 代码与源站配置对应位置

### 4.1 后端（`backend/`）

- `backend/src/modules/cover/services/cover.service.ts`
  - 支持 `size: 'full' | 'thumb'` 与 `forceFormat?: 'webp' | 'png'`。
  - `size=thumb` 懒生成 `200×200 WebP (quality 75)` 并落盘为 `<id>.thumb.webp`，内置进程内 `thumbInFlight` 去重防止冷启动并发击穿。
- `backend/src/api/catalog/cover-catalog.controller.ts`
  - `GET /api/v1/catalog/covers/:id` 支持 `?format=webp|png&size=thumb|full`。
  - 显式传入 `format` 时不返回 `Vary: Accept`，提升 CDN 与代理缓存命中率；未传时保持旧行为向后兼容。
- `backend/src/api/catalog/music-catalog.controller.ts`
  - `GET /api/v1/catalog/music` 与 `GET /api/v1/catalog/music/aliases` 返回：
    `Cache-Control: public, max-age=600, s-maxage=1800, stale-while-revalidate=3600`。

### 4.2 源站 Host Nginx（`backend/host-nginx/msh-web-locations.conf`）

- `location ~ ^/api/v1/catalog/music(?:/aliases)?$`：接入 `proxy_cache msh_api_cache`（30m），避免旧配置中已失效的 `/api/music` 路径导致曲库无法命中源站缓存。
- `location ^~ /api/v1/catalog/covers/`：接入 `proxy_cache msh_image_cache`（30d），仅当 `$arg_format` 非空时启用缓存（未传 `format` 的旧客户端直接透传，避免 WebP/PNG 协商混用）。
- 根目录与公共静态图（`/favicon.*`、`/pwa-*.png`、`/friendcode.png`、`/avatar-placeholder.svg`、`/mai/pic/*`、`/community/*`）：统一附加 `Cache-Control: public, max-age=604800`。

### 4.3 前端（`frontend/`）

- `frontend/src/api/cdnUrl.ts`
  - 导出 `CDN_BASE_URL` 与 `cdnUrl(path)`。生产构建默认 `https://cdn.maiscorehub.bakapiano.com`，本地开发默认空字符串（走 Vite dev server 相对路径），可通过构建环境变量 `VITE_CDN_BASE_URL` 覆盖或置空回退。
- `frontend/vite.config.ts`
  - 通过 `experimental.renderBuiltUrl` 在生产构建时仅将 `assets/*` 重写为 `${cdnBaseUrl}/assets/...`，保持 `index.html`、`manifest.webmanifest`、`sw.js`、`/favicon.png` 同源。
- `frontend/src/api/appClient.ts`
  - 曲库客户端 `musicApi` 指向 `${CDN_BASE_URL}/api/v1`（仅读公开曲库与别名），其余业务 API 客户端继续走同源 `/api/v1`。
- `frontend/src/utils/maimaiImages.ts`、`frontend/src/components/MusicScoreCard/utils.tsx`、`frontend/src/components/ProfileCard.tsx`、`frontend/src/components/AppHeader.tsx`、`frontend/src/pages/AboutPage.tsx`
  - 曲绘默认请求 `?v=4&format=webp&size=thumb` 经 CDN；华立 `/maimai-mobile/img/*`、`/mai/pic/*` 与 `/favicon.webp` 统一走 `cdnUrl()`。
- `frontend/public/sw.js`
  - `CACHE_NAME` 升级至 `maimai-score-hub-app-v2`，支持对 `https://cdn.maiscorehub.bakapiano.com/assets/*` 的缓存命中，并预缓存 `/favicon.webp`。
- `frontend/public/favicon.{png,webp}` & `pwa-*.png`
  - 压缩优化站点图标（`favicon.png` 从 445 KB 降至 ~4.3 KB，新增 3.8 KB `favicon.webp`；PWA 图标同步无损/轻量压缩）。

---

## 5. TLS 证书与自动续签

`cdn.maiscorehub.bakapiano.com` 的 HTTPS 证书由 **Server 5** 上的 root `acme.sh` 统一签发并自动续签：

- **签发方式**：DNS-01（`--dns dns_ali`），CA 为 Let's Encrypt，密钥类型 RSA-2048（兼容阿里云 CDN 证书上传规范）。
- **自动部署**：通过 `acme.sh` 内置的 `--deploy-hook ali_cdn` 自动调用阿里云 CDN OpenAPI（`SetCdnDomainSSLCertificate`）将新证书推送至 `cdn.maiscorehub.bakapiano.com`。
- **续签计划**：由 Server 5 现有 `root` crontab（`0 0,6,12,18 * * *`）自动检查并在到期前 30 天内续签与重新部署。
- **凭据最小权限建议**：当前 `acme.sh` 凭据保存在 Server 5 `/root/.acme.sh/account.conf`（权限 `600`）。后续建议在阿里云 RAM 控制台创建仅含 `AliyunDNSFullAccess` + `AliyunCDNFullAccess` 策略的专用子账号 AK 替换主账号 AK。

---

## 6. 运维与故障排查手册

### 6.1 部署顺序

涉及曲绘参数、曲库缓存头或 Host Nginx 缓存规则变更时，必须**先部署后端，再部署前端**：

```bash
gh workflow run deploy-backend.yml --ref main -f confirm_dxnet_v2_cutover=false
# 等待 backend 成功后再部署前端
gh workflow run deploy-frontend.yml --ref main
```

### 6.2 验证 CDN 缓存与跨域头

```bash
# 验证曲绘缩略图（第二次请求应看到 X-Cache: HIT、Access-Control-Allow-Origin: *）
curl -sI "https://cdn.maiscorehub.bakapiano.com/api/v1/catalog/covers/11810?v=4&format=webp&size=thumb"

# 验证曲库 JSON（应看到 content-encoding: br 或 gzip，以及 X-Cache: HIT）
curl -sI -H "Accept-Encoding: br, gzip" "https://cdn.maiscorehub.bakapiano.com/api/v1/catalog/music"

# 验证华立资源代理经 CDN
curl -sI "https://cdn.maiscorehub.bakapiano.com/maimai-mobile/img/icon_star.png"
```

### 6.3 主动刷新缓存（曲库紧急更新时）

曲库默认在 CDN 边缘缓存 30 分钟；若新增歌曲或修正谱面需要立即对全网生效，可在阿里云 CDN 控制台「刷新预热」提交 URL 刷新，或通过阿里云 CDN OpenAPI 调用 `RefreshObjectCaches` 刷新以下两条 URL：

- `https://cdn.maiscorehub.bakapiano.com/api/v1/catalog/music`
- `https://cdn.maiscorehub.bakapiano.com/api/v1/catalog/music/aliases`

### 6.4 紧急降级（绕过 CDN 回退源站）

若 CDN 出现区域故障或证书异常，可立即在构建时将 `VITE_CDN_BASE_URL` 设为空字符串重新构建发布前端，所有静态资源、曲绘与曲库将无缝回退至源站 `maiscorehub.bakapiano.com` 同源加载。

### 6.5 费用与防刷保护

- 建议在阿里云 CDN 控制台 -> 域名管理 -> `cdn.maiscorehub.bakapiano.com` -> **用量封顶** 中设置带宽/流量上限阈值（例如单小时带宽上限或单日流量上限）并开启超限告警/自动下线，防止异常刷量产生超额账单。
