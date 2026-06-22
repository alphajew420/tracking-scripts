# Internal Notes

This file is for operator-only notes, validation commands, and deployment details.

## FedEx Working Path

FedEx is the reference carrier for the warm-reuse path.

Verified flow:
- warm one carrier session in a long-lived worker
- reuse the same warmed browser sidecar for subsequent FedEx lookups
- re-warm only when the carrier session expires or gets invalidated

Validation commands:

```bash
npm run probe:bandwidth-fedex -- 382150811542 521355676935
npm run fedex:canary -- 382150811542
npm run carriers:status
npm run carriers:validate
```

## FedEx Runtime

FedEx stays on the browser-extension proxy path when a proxy is present. The code treats that as the default instead of exposing multiple FedEx proxy modes.

## Deployment Notes

Known-good production behavior from the VPS:
- FedEx runs in system Chrome with `HEADLESS_FEDEX=false`
- FedEx uses the worker-held warm session for repeat lookups
- the worker and canary are separate processes, so one process being warm does not warm the other
- `restart: unless-stopped` keeps the services up across daemon restarts, but a recreated container still cold-starts its own browser/session
