FROM node:22.23.4-alpine

RUN node -e "if (!Number.isInteger(require('node:zlib').constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH)) throw new Error('CVE-2026-111497 runtime patch required')"

WORKDIR /app
COPY server.mjs /app/server.mjs

EXPOSE 3901
CMD ["node", "/app/server.mjs"]
