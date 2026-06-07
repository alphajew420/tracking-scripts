# tracking-scripts

Carrier tracking library + CLI + bandwidth probes for **UPS, FedEx, DHL, DHL Express, and USPS**. Browser-driven scrapers and official-API clients side by side, behind one `TrackingSession` interface.

Extracted from the Shippified codebase so the carrier logic can be vendored, audited, or shipped standalone.

## Install

```bash
npm install
# postinstall pulls Chromium for Playwright
```

System Chrome (`channel: "chrome"`) is required for UPS scraper (reCAPTCHA flags bundled Chromium) — install Chrome separately or set the `--chrome` flag.

## CLI

```bash
# scraper mode (no credentials)
npm run track -- usps 9400111899223816042167
npm run track -- ups 1Z999AA10123456784
npm run track -- fedex 123456789012
npm run track -- dhl 00340434292135100186
npm run track -- dhl-express 1234567890

# API mode (credentials in env required)
DHL_API_KEY=...      npm run track -- dhl 00340434292135100186 --api
UPS_CLIENT_ID=...    UPS_CLIENT_SECRET=...    npm run track -- ups 1Z... --api
FEDEX_CLIENT_ID=...  FEDEX_CLIENT_SECRET=...  npm run track -- fedex 12345... --api

# misc flags
--json     # full ScrapeResult as JSON
--debug    # verbose session logging
--chrome   # force system Chrome (auto-on for scraper UPS)
```

USPS has no free tracking API — scraper only.

## Library

```ts
import { TrackingSession, uspsCarrier, createUpsApiCarrier } from "tracking-scripts";

// Scraper:
const s1 = new TrackingSession(uspsCarrier);
const r1 = await s1.track("9400111899223816042167");
await s1.close();

// Official API:
const s2 = new TrackingSession(
  createUpsApiCarrier({ clientId: "...", clientSecret: "..." })
);
const r2 = await s2.track("1Z...");
await s2.close();
```

A single warm `TrackingSession` can run many queries — re-warming only happens on detected expiry (Akamai cookie aged out, OAuth token rejected, etc.).

## Architecture

```
src/
  types.ts         Status, Event, Track, ScrapeResult
  session.ts       TrackingSession + ScraperCarrier / ApiCarrier interfaces
  cli.ts           `npm run track` entry
  index.ts         public exports
  carriers/
    usps.ts            scraper (fetch via page.evaluate, parse via DOMParser)
    dhl.ts             scraper (JSON XHR to /int-verfolgen/data/search)
    dhl-express.ts     scraper (SPA HTML parse)
    ups.ts             scraper (XHR POST with XSRF cookie, requires system Chrome)
    fedex.ts           scraper (capture bearer token during warm, then XHR POST)
    dhl-api.ts         API client (DHL_API_KEY)
    dhl-express-api.ts thin wrapper over dhl-api
    ups-api.ts         API client (UPS_CLIENT_ID + UPS_CLIENT_SECRET, OAuth)
    fedex-api.ts       API client (FEDEX_CLIENT_ID + FEDEX_CLIENT_SECRET, OAuth)
```

### How the scrapers stay light

`TrackingSession` warms a Playwright `Page` once (`page.goto(warmUrl)`) which mints anti-bot cookies + Akamai sensor approval. Every subsequent lookup runs inside the warm page via `page.evaluate(fetch ...)` so cookies, Chrome TLS fingerprint, and HTTP/2 connection are all reused — no asset reload.

Heavy resource types (`image`, `font`, `media`, `stylesheet`) and known ad/tracker domains are blocked at the Playwright route layer (`src/session.ts`). Set `NO_BLOCKING=1` to disable while debugging.

### Bandwidth (USPS, measured)

| Mode | Per-query bytes | Notes |
|---|---|---|
| Cold `page.goto()` each time | 3.15 MB | Original `bandwidth_usps.ts` baseline |
| Warm + `page.evaluate(fetch)` (current production) | ~1.22 MB | SPA re-renders + analytics fire per call |
| Warm + `context.request.get()` (raw) | ~70 KB | Bypasses page lifecycle entirely — 18× cheaper |

The third mode is exercised in `probes/bandwidth_usps_warm.ts` with `MODE=raw`. The carrier scraper itself still uses `page.evaluate(fetch)` because that path is what Akamai signs off on; a future refactor could switch to `context.request` once we verify it doesn't break the carriers' anti-bot detection.

## Probes

Throwaway investigation scripts under `probes/`. They reach into `src/` directly. Run with `tsx`:

```bash
npx tsx probes/bandwidth_usps_warm.ts <tracking#>          # warm + raw bandwidth comparison
NO_BLOCKING=1 npx tsx probes/bandwidth_usps_warm.ts ...    # full asset load (matches real browser)
MODE=raw npx tsx probes/bandwidth_usps_warm.ts ...         # the 70 KB path
```

## License

MIT.
