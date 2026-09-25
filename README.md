# SoloSync Backend

Simple production-oriented API for SoloSync user authentication. Node.js + Express + TypeScript + MongoDB + Redis.

## Features

- Register, login, refresh and logout
- Password hashing with bcrypt
- Short-lived access JWT and Redis-backed refresh sessions
- HTTP-only cookies
- CORS, Helmet and auth rate limiting
- /health and /ready endpoints
- Docker and GitHub Actions

## Local

    cp .env.example .env
    npm install
    npm run dev

Or run MongoDB, Redis and the API together:

    docker compose up --build

API: http://localhost:4000

## Production environment

Set MONGODB_URI and REDIS_URL to your existing managed services and generate a strong JWT_SECRET. Set FRONTEND_ORIGIN to the exact frontend origin. Never commit secrets.

## API

POST /api/auth/register { email, password }
POST /api/auth/login { email, password }
POST /api/auth/refresh
POST /api/auth/logout
GET /api/auth/me
GET /health
GET /ready

The messaging provider is intentionally abstracted from authentication. A production WhatsApp implementation should use an authorized provider; any experimental adapter must remain isolated from the auth core.