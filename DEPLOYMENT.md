# Trackified Local Docker Deployment

## Services

The local stack is defined in `docker-compose.yml`:

- `web`: Next.js dashboard and white-label pages.
- `api`: REST API, migrations on startup.
- `worker`: BullMQ scrape worker with warmed browser session pooling.
- `scheduler`: periodic `next_scrape_at` scanner that enqueues due scrapes.
- `postgres`: persistent tracking/API/webhook state.
- `redis`: BullMQ queues and future realtime pub/sub.

## Local Ports

Host ports avoid existing local services:

- Frontend: http://localhost:3017/dashboard
- Public tracking page: http://localhost:3017/t/demo
- API: http://localhost:8788

The API listens on `8787` inside Docker and maps to `8788` on the host because another local app already owns `8787`.

## Start

```bash
docker compose up -d --build
```

## Production Environment

Copy `.env.example` to `.env.production` and set at minimum:

```bash
APP_BASE_URL=https://your-domain.com
API_PUBLIC_BASE_URL=https://api.your-domain.com
CORS_ORIGIN=https://your-domain.com
COOKIE_SECURE=true
TRACKING_API_KEYS=<rotated bootstrap/admin key or blank after first account setup>
DATABASE_URL=<managed postgres url>
REDIS_URL=<managed redis url>
EMAIL_PROVIDER=resend
EMAIL_FROM="Trackified <no-reply@your-domain.com>"
RESEND_API_KEY=<resend key>
STRIPE_SECRET_KEY=<stripe secret>
STRIPE_WEBHOOK_SECRET=<stripe webhook signing secret>
STRIPE_PRICE_STARTER=<price id>
STRIPE_PRICE_PRO=<price id>
STRIPE_PRICE_SCALE=<price id>
```

Local development uses `EMAIL_PROVIDER=dev`; emails are written to the dashboard email outbox.

## Production Cutover Checklist

- Point the domain/reverse proxy at `web:3000` and API domain at `api:8787`.
- Set `COOKIE_SECURE=true` only after HTTPS is active.
- Set Stripe webhook target to `/v1/billing/stripe/webhook`.
- Set email DNS records for the selected provider before switching from `dev`.
- Remove `test_dev_key` from `TRACKING_API_KEYS`.
- Confirm `/healthz`, `/openapi.json`, signup, login, billing checkout, invite, reset, and public tracking pages.
- Confirm Postgres backups and Redis persistence policy match the host disk budget.
- Rebuild both images if carrier worker code changed: `Dockerfile.light` and `Dockerfile`.

## Smoke Tests

```bash
curl http://localhost:8788/healthz

curl -H 'Authorization: Bearer test_dev_key' \
  'http://localhost:8788/v1/carriers/detect?number=1Z999AA10123456784'

curl -I http://localhost:3017/dashboard
```

## Proxy Configuration

Set sticky proxies in the environment before starting Compose:

```bash
PROXY_DEFAULT=http://proxy-host:port docker compose up -d
PROXY_USPS=http://usps-proxy:port docker compose up -d
PROXY_UPS=http://ups-proxy:port docker compose up -d
PROXY_FEDEX=http://fedex-proxy:port docker compose up -d
```

Warm navigation and all `page.evaluate(fetch)` queries stay inside the same browser context and proxy.

## Current Host Note

During setup, Docker hit a disk-full/containerd I/O error while writing browser image layers. The existing stack continued to serve:

- `http://localhost:8788/healthz`
- `http://localhost:3017/dashboard`

If Docker cannot rebuild or exec and reports `input/output error`, restart Docker Desktop/containerd, then run:

```bash
docker compose down
docker compose up -d --build
```

Do not use `--volumes` unless you intend to delete local Postgres/Redis data.
