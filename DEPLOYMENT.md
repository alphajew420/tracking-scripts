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

FedEx is sensitive to browser surface and proxy exit quality. The working VPS profile is:

- Worker process runs under explicit Xvfb, not `xvfb-run` as the long-lived PID.
- FedEx runs in system Chrome with `HEADLESS_FEDEX=false`.
- Proxy mode is `forwarder`; extension mode did not apply reliably in Linux/headless containers.
- Browser UA is native Chrome; do not force the old macOS spoof on the VPS.
- Tracking surface is the direct FedEx tracking URL, not the landing-page submit flow.
- CDP autolaunch is disabled for FedEx; the worker owns the browser session.
- Use a known-good sticky proxy session first, with optional fallback sessions for controlled rotation.

```bash
PROXY_FEDEX=http://fedex-proxy:port
PROXY_FEDEX_USERNAME=<username>
PROXY_FEDEX_PASSWORD=<password>
PROXY_FEDEX_MODE=forwarder
PROXY_SESSION_FEDEX=<known-good-session>
PROXY_SESSION_FALLBACKS_FEDEX=<fallback-session-1>,<fallback-session-2>
FEDEX_ALLOW_DYNAMIC_PROXY_SESSIONS=false
FEDEX_USE_PROXY=true
FEDEX_TRACK_SURFACE=direct
BROWSER_CHANNEL_FEDEX=chrome
BROWSER_USER_AGENT_FEDEX=native
BROWSER_EXTRA_ARGS_FEDEX="--no-sandbox --disable-dev-shm-usage"
BROWSER_CDP_AUTOLAUNCH_FEDEX=false
FEDEX_FINGERPRINT_PROFILE=none
HEADLESS=true
HEADLESS_FEDEX=false
SESSION_MAX_AGE_MS=3600000
SESSION_MAX_USES=250
FEDEX_PROFILE_DIR=/tmp/trackified-fedex-profile-worker
```

The Compose worker command starts Xvfb and then execs the Node worker:

```yaml
command: ["sh", "-lc", "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp & export DISPLAY=:99; exec npm run worker"]
```

Do not run FedEx lookups in the API process. `POST /v1/trackings`, `/v1/trackings/bulk`, and `/v1/trackings/{id}/retrack` enqueue jobs, and the worker keeps the browser session hot.

Run the FedEx canary after deploys or proxy changes:

```bash
docker compose -f docker-compose.prod.yml exec -T worker npm run fedex:canary -- 382150811542
```

Known-good proof from the VPS on June 22, 2026: the live API queued `382150811542`, the worker scraped FedEx successfully, and `GET /v1/trackings/:id` returned `in_transit` with 5 events. The first event was `Arrived at FedEx location`, `AURORA, CO`, `2026-06-21 01:27:00`.

### CDP Browser Sidecar

Royal Mail and PostNord can use an already-running Chrome profile when their public sites behave differently in a freshly launched automation profile. Start a Chrome sidecar with remote debugging, warm/solve the carrier page once, then point the worker at that CDP endpoint:

```bash
npm run cdp:chrome -- royal-mail --port=9222
curl -X POST http://localhost:8787/v1/trackings \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d '{"tracking_number":"ME762746131GB","carrier":"royal-mail"}'
```

For PostNord:

```bash
npm run cdp:chrome -- postnord-se --port=9223
curl -X POST http://localhost:8787/v1/trackings \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d '{"tracking_number":"66695159070SE","carrier":"postnord-se"}'
```

If you use a manual browser proxy extension, launch Chrome with the profile that already has that extension configured, then use `BROWSER_CDP_ENDPOINT_*` to attach. If you use env-based proxies instead, `npm run cdp:chrome` loads Trackified's generated proxy extension automatically when `PROXY_*` env vars are present.

Diagnostic commands:

```bash
npm run browser:surface -- royal-mail 'https://www.royalmail.com/track-your-item#/tracking-results/ME762746131GB' --country=gb
npm run proxy:diagnose -- royal-mail ME762746131GB --attempts=1 --country=gb
```

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
