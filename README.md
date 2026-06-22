# tracking-scripts

Carrier tracking library + API + bandwidth probes for **UPS, FedEx, DHL, DHL Express, USPS**, and config-driven carrier adapters. All carrier lookups are browser-driven scrapers behind one `TrackingSession` interface.

Extracted from the Shippified codebase so the carrier logic can be vendored, audited, or shipped standalone.

## Install

```bash
npm install
# postinstall pulls Chromium for Playwright
```

System Chrome (`channel: "chrome"`) is required for UPS scraper (reCAPTCHA flags bundled Chromium) — install Chrome separately or set the `--chrome` flag.

Operational notes and validation commands live in [`INTERNAL.md`](/Users/shinbetsolutions/ForgeDeck/trackified/tracking-scripts/INTERNAL.md).

## API testing

```bash
curl -X POST http://localhost:8787/v1/trackings \
  -H "Authorization: Bearer test_or_live_api_key" \
  -H "Content-Type: application/json" \
  -d '{"tracking_number":"9400111899223816042167","carrier":"usps"}'

curl -X POST http://localhost:8787/v1/trackings/bulk \
  -H "Authorization: Bearer test_or_live_api_key" \
  -H "Content-Type: application/json" \
  -d '{"trackings":[{"tracking_number":"1Z999AA10123456784","carrier":"ups"}]}'
```

## Library

```ts
import { TrackingSession, uspsCarrier } from "tracking-scripts";

const session = new TrackingSession(uspsCarrier);
const result = await session.track("9400111899223816042167");
await session.close();
```

A single warm `TrackingSession` can run many queries. Re-warming only happens on detected expiry, such as an aged-out Akamai cookie.

## Architecture

```
src/
  types.ts         Status, Event, Track, ScrapeResult
  session.ts       TrackingSession + ScraperCarrier interface
  cli.ts           internal-only legacy helper; not exposed by package scripts
  index.ts         public exports
  server.ts        REST API skeleton
  detect.ts        tracking-number carrier detection
  config/
    adapter.ts         config-driven scraper adapter factory
  carriers/
    usps.ts            scraper (fetch via page.evaluate, parse via DOMParser)
    dhl.ts             scraper (JSON XHR to /int-verfolgen/data/search)
    dhl-express.ts     scraper (DHL /utapi JSON endpoint after browser challenge warm)
    ups.ts             scraper (XHR POST with XSRF cookie, requires system Chrome)
    fedex.ts           scraper (capture bearer token during warm, then XHR POST)
    configs/           JSON carrier adapter definitions
```

### How the scrapers stay light

`TrackingSession` warms a Playwright `Page` once (`page.goto(warmUrl)`) which mints anti-bot cookies + Akamai sensor approval. Every subsequent lookup runs inside the warm page via `page.evaluate(fetch ...)` so cookies, Chrome TLS fingerprint, and HTTP/2 connection are all reused — no asset reload.

Heavy resource types (`image`, `font`, `media`, `stylesheet`) and known ad/tracker domains are blocked at the Playwright route layer (`src/session.ts`). Set `NO_BLOCKING=1` to disable while debugging.

### Bandwidth (USPS, measured)

| Mode | Per-query bytes | Notes |
|---|---|---|
| Cold `page.goto()` each time | 3.15 MB | Original `bandwidth_usps.ts` baseline |
| Warm + `page.evaluate(fetch)` (current production) | ~1.22 MB | SPA re-renders + analytics fire per call |
| Warm + tightened route blocker | ~70-100 KB target | Keeps only the response path and anti-bot pings |

The carrier scraper uses `page.evaluate(fetch)` because that path is what Akamai signs off on. `context.request` uses Node's network stack and should not be used for anti-bot-sensitive carrier data fetches.

### FedEx runtime

FedEx uses a carrier-scoped browser sidecar plus a warm `TrackingSession`. The worker reuses that session across lookups while it remains valid.

## Probes

Throwaway investigation scripts under `probes/`. They reach into `src/` directly. Run with `tsx`:

```bash
npx tsx probes/bandwidth_usps_warm.ts <tracking#>          # warm + raw bandwidth comparison
NO_BLOCKING=1 npx tsx probes/bandwidth_usps_warm.ts ...    # full asset load (matches real browser)
MODE=raw npx tsx probes/bandwidth_usps_warm.ts ...         # the 70 KB path
```

## License

MIT.
