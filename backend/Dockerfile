FROM node:22.23.4-alpine AS builder

# Build shared package first
WORKDIR /app/shared
COPY shared/package*.json ./
RUN npm ci
COPY shared/ ./
RUN npm run build

# Build backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --install-links=true
COPY backend/ ./
RUN npm run build

FROM node:22.23.4-alpine

# Node backports the Brotli fix while retaining its 1.1.0 version string.
RUN node -e "if (!Number.isInteger(require('node:zlib').constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH)) throw new Error('CVE-2026-111497 runtime patch required')"

# 安装 fontconfig 以支持字体渲染，以及 curl 用于健康检查
# Bound the CDN attempt on mainland hosts. The fallback changes only the
# download location; Alpine's trusted package-signing keys remain unchanged.
RUN if ! timeout 90 apk add --no-cache fontconfig curl; then \
      sed 's|https://dl-cdn.alpinelinux.org/alpine|https://mirrors.tuna.tsinghua.edu.cn/alpine|g' \
        /etc/apk/repositories > /tmp/apk-repositories; \
      timeout 180 apk --repositories-file /tmp/apk-repositories add --no-cache fontconfig curl; \
    fi \
    && rm -f /tmp/apk-repositories

# Copy built shared package so install-links can copy it
WORKDIR /app/shared
COPY --from=builder /app/shared/ ./

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --install-links=true --omit=dev

COPY --from=builder /app/backend/dist ./dist
COPY backend/assets ./assets

EXPOSE 9050

ENV NODE_OPTIONS="--max-old-space-size=3072"

CMD ["node", "dist/main"]
