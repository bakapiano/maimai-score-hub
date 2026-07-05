FROM node:22-alpine AS builder

WORKDIR /app/shared
COPY shared/package*.json ./
RUN npm ci
COPY shared/ ./
RUN npm run build

WORKDIR /app/admin
COPY admin/package*.json ./
RUN npm install --install-links=true
COPY admin/ ./
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=builder /app/admin/dist /usr/share/nginx/html
COPY admin/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
