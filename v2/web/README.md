# v2/web

This folder contains a new web project with:

- `backend/`: NestJS + MongoDB (username + password authentication)
- `frontend/`: React (Vite)

## Prerequisites

- Node.js + npm
- Docker (recommended, for MongoDB)

## Start MongoDB (recommended)

From `v2/web/`:

```powershell
docker compose up -d
```

MongoDB will listen on `localhost:27017` with:

- user: `root`
- password: `example`

## Backend

1) Create env file:

```powershell
cd backend
copy .env.example .env
```

2) Install + run:

```powershell
npm install
npm run start:dev
```

Backend listens on `http://localhost:3000`.

- Health: `GET http://localhost:3000/api/health`
- Jobs:
  - `GET http://localhost:3000/api/jobs`
  - `POST http://localhost:3000/api/jobs` with JSON `{ "friendCode": "...", "skipUpdateScore": true }`

## Frontend

```powershell
cd ../frontend
npm install
npm run dev
```

Frontend dev server will proxy `/api/*` to `http://localhost:3000`.
