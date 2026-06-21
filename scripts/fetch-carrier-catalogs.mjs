import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.resolve("data/carrier-catalogs");
const AFTERSHIP_URL = "https://track.aftership.com/couriers/download";
const SEVENTEEN_TRACK_URL =
  "https://res.17track.net/asset/carrier/info/carrier.all.js";

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Trackified carrier-catalog-sync/1.0 (+https://trackified.com)",
      accept: "text/html,application/javascript,text/csv,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];

    if (quoted && char === '"' && next === '"') {
      value += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (!quoted && char === ",") {
      row.push(value);
      value = "";
      continue;
    }

    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(value);
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      value = "";
      continue;
    }

    value += char;
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  const [headers, ...records] = rows;
  return records.map((record) =>
    Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])),
  );
}

function parse17TrackRegistry(js) {
  const match = js.match(/return (\[.*\]);\}\)\);/s);
  if (!match) {
    throw new Error("Could not parse 17TRACK carrier registry response.");
  }

  return JSON.parse(match[1]);
}

function normalizeAfterShip(rows) {
  return rows
    .map((row) => ({
      source: "aftership",
      slug: row["Courier Slug"]?.trim(),
      name: row["Courier Name"]?.trim(),
    }))
    .filter((carrier) => carrier.slug && carrier.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalize17Track(rows) {
  return rows
    .map((row) => ({
      source: "17track",
      carrier_key: String(row.key),
      name: String(row._name ?? "").trim(),
      country_iso: String(row._country_iso ?? "").trim() || null,
      url: String(row._url ?? "").trim() || null,
      group: String(row._group ?? "").trim() || null,
      scope: Array.isArray(row._scope) ? row._scope : [],
    }))
    .filter((carrier) => carrier.carrier_key && carrier.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function csvEscape(value) {
  const stringValue = value == null ? "" : String(value);
  if (!/[",\n\r]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replaceAll('"', '""')}"`;
}

function toCsv(rows, headers) {
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
    "",
  ].join("\n");
}

function sourceMeta(sourceUrl, count) {
  return {
    generated_at: new Date().toISOString(),
    source_url: sourceUrl,
    count,
  };
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildCombined(aftership, seventeenTrack) {
  const byName = new Map();

  for (const carrier of aftership) {
    const key = normalizeName(carrier.name);
    byName.set(key, {
      normalized_name: key,
      display_name: carrier.name,
      aftership_slug: carrier.slug,
      seventeen_track_key: null,
      country_iso: null,
      url: null,
      sources: ["aftership"],
    });
  }

  for (const carrier of seventeenTrack) {
    const key = normalizeName(carrier.name);
    const existing = byName.get(key);

    if (existing) {
      existing.seventeen_track_key = carrier.carrier_key;
      existing.country_iso = carrier.country_iso;
      existing.url = carrier.url;
      existing.sources = ["aftership", "17track"];
      continue;
    }

    byName.set(key, {
      normalized_name: key,
      display_name: carrier.name,
      aftership_slug: null,
      seventeen_track_key: carrier.carrier_key,
      country_iso: carrier.country_iso,
      url: carrier.url,
      sources: ["17track"],
    });
  }

  return [...byName.values()].sort((a, b) =>
    a.display_name.localeCompare(b.display_name),
  );
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const [aftershipCsv, seventeenTrackJs] = await Promise.all([
    fetchText(AFTERSHIP_URL),
    fetchText(SEVENTEEN_TRACK_URL),
  ]);

  const aftership = normalizeAfterShip(parseCsv(aftershipCsv));
  const seventeenTrack = normalize17Track(parse17TrackRegistry(seventeenTrackJs));
  const combined = buildCombined(aftership, seventeenTrack);

  await writeFile(
    path.join(OUT_DIR, "aftership-carriers.json"),
    `${JSON.stringify({ ...sourceMeta(AFTERSHIP_URL, aftership.length), carriers: aftership }, null, 2)}\n`,
  );
  await writeFile(
    path.join(OUT_DIR, "aftership-carriers.csv"),
    toCsv(aftership, ["slug", "name"]),
  );

  await writeFile(
    path.join(OUT_DIR, "17track-carriers.json"),
    `${JSON.stringify({ ...sourceMeta(SEVENTEEN_TRACK_URL, seventeenTrack.length), carriers: seventeenTrack }, null, 2)}\n`,
  );
  await writeFile(
    path.join(OUT_DIR, "17track-carriers.csv"),
    toCsv(seventeenTrack, [
      "carrier_key",
      "name",
      "country_iso",
      "url",
      "group",
    ]),
  );

  await writeFile(
    path.join(OUT_DIR, "combined-carrier-candidates.json"),
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        sources: [AFTERSHIP_URL, SEVENTEEN_TRACK_URL],
        count: combined.length,
        carriers: combined,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(OUT_DIR, "combined-carrier-candidates.csv"),
    toCsv(combined, [
      "display_name",
      "normalized_name",
      "aftership_slug",
      "seventeen_track_key",
      "country_iso",
      "url",
    ]),
  );

  console.log(`AfterShip carriers: ${aftership.length}`);
  console.log(`17TRACK carriers: ${seventeenTrack.length}`);
  console.log(`Combined candidates: ${combined.length}`);
  console.log(`Wrote ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
