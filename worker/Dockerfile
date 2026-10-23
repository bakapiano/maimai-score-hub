FROM node:22.23.4-slim

RUN node -e "if (!Number.isInteger(require('node:zlib').constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH)) throw new Error('CVE-2026-111497 runtime patch required')"

# Build shared package first
WORKDIR /app/shared
COPY shared/package*.json ./
RUN npm ci
COPY shared/ ./
RUN npm run build

# Install worker dependencies (shared must be built before install --install-links copies it)
WORKDIR /app/worker
COPY worker/package*.json ./
RUN npm install --install-links=true --omit=dev
COPY worker/ ./

# ENV NODE_ENV=production

EXPOSE 3999 2222

CMD ["npm", "run", "start"]
