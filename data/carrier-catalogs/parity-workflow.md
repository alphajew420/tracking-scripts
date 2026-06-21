# Carrier Parity Workflow

Goal: work the combined 17TRACK + AfterShip catalog one carrier at a time until Trackified has competitor-parity coverage.

## States

- `candidate`: present in competitor catalog, not evaluated yet.
- `planned`: selected for implementation and assigned a priority tier.
- `module_scaffolded`: config or code module exists.
- `fixture_needed`: module exists but needs real/public fixture samples.
- `verified`: module has passed validation against known tracking samples.
- `blocked`: carrier requires account access, captcha-only flow, region-only access, or another documented blocker.
- `deprecated`: carrier appears stale, merged, or no longer has a usable tracking surface.

## Implementation Modes

- `dedicated_scraper`: custom TypeScript module for major carriers, heavy JavaScript apps, anti-bot surfaces, or JSON APIs hidden behind browser state.
- `config_adapter`: JSON module using the generic warm/fetch/parse adapter.
- `handoff_only`: carrier primarily appears as an origin or last-mile leg and should be stitched to another module.
- `research_required`: not enough public tracking-surface detail yet.

## Per-Carrier Checklist

1. Confirm public tracking URL and sample tracking-number formats.
2. Decide `dedicated_scraper` vs `config_adapter`.
3. Add config/code module with status mapping.
4. Add detection regex if the format is distinct enough.
5. Add fixture numbers or HTML snapshots where available.
6. Run `npm run carriers:validate`.
7. Run `npm run typecheck`.
8. Test with a real recent tracking number before marking `verified`.
9. Measure warm and same-session lookup bandwidth.
10. Add amortized proxy cost to `provider-economics.json` before treating the provider as launch-ready.

## Refresh Commands

```sh
npm run carriers:catalog
npm run carriers:validate
```
