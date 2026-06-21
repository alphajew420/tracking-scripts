# Carrier Catalog Sources

Generated on demand with:

```sh
npm run carriers:catalog
```

Files:

- `aftership-carriers.json` / `aftership-carriers.csv`: carrier slug and name rows from AfterShip's courier download endpoint.
- `17track-carriers.json` / `17track-carriers.csv`: carrier key, name, country, URL, group, and scope rows from 17TRACK's public carrier registry asset.
- `combined-carrier-candidates.json` / `combined-carrier-candidates.csv`: normalized name merge across both sources for registry planning and dedupe review.

Source URLs:

- AfterShip: `https://track.aftership.com/couriers/download`
- 17TRACK: `https://res.17track.net/asset/carrier/info/carrier.all.js`
