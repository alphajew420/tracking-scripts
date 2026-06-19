# tracking-scripts

Carrier tracking library + CLI + bandwidth probes for **UPS, FedEx, DHL, DHL Express, USPS**, and config-driven carrier adapters. All carrier lookups are browser-driven scrapers behind one `TrackingSession` interface.

Extracted from the Shippified codebase so the carrier logic can be vendored, audited, or shipped standalone.

## Install

```bash
npm install
# postinstall pulls Chromium for Playwright
```

System Chrome (`channel: "chrome"`) is required for UPS scraper (reCAPTCHA flags bundled Chromium) — install Chrome separately or set the `--chrome` flag.

## CLI

```bash
npm run track -- usps 9400111899223816042167
npm run track -- ups 1Z999AA10123456784
npm run track -- fedex 123456789012
npm run track -- dhl 00340434292135100186
npm run track -- dhl-express 1234567890
npm run track -- detect 1Z999AA10123456784

# misc flags
--json     # full ScrapeResult as JSON
--debug    # verbose session logging
--chrome   # force system Chrome (auto-on for scraper UPS)
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
  cli.ts           `npm run track` entry
  index.ts         public exports
  server.ts        REST API skeleton
  detect.ts        tracking-number carrier detection
  config/
    adapter.ts         config-driven scraper adapter factory
  carriers/
    usps.ts            scraper (fetch via page.evaluate, parse via DOMParser)
    dhl.ts             scraper (JSON XHR to /int-verfolgen/data/search)
    dhl-express.ts     scraper (SPA HTML parse)
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

## Probes

Throwaway investigation scripts under `probes/`. They reach into `src/` directly. Run with `tsx`:

```bash
npx tsx probes/bandwidth_usps_warm.ts <tracking#>          # warm + raw bandwidth comparison
NO_BLOCKING=1 npx tsx probes/bandwidth_usps_warm.ts ...    # full asset load (matches real browser)
MODE=raw npx tsx probes/bandwidth_usps_warm.ts ...         # the 70 KB path
```

## License

MIT.
