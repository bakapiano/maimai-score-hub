FROM node:20-alpine AS builder

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

FROM node:20-alpine

# 安装 fontconfig 以支持字体渲染，以及 curl 用于健康检查
RUN apk add --no-cache fontconfig curl

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
