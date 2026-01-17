FROM node:22.6.0-slim

WORKDIR /app/worker

COPY worker/package.json ./

RUN npm install --omit=dev

COPY worker/ ./

ENV NODE_ENV=production

EXPOSE 3999 2222

CMD ["npm", "run", "start"]
