FROM node:22-alpine AS builder

# Build shared package first
WORKDIR /app/shared
COPY shared/package*.json ./
RUN npm ci
COPY shared/ ./
RUN npm run build

# Install frontend dependencies (shared must be built before install --install-links copies it)
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install --install-links=true
COPY frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
