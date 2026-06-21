import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CATALOG_PATH = path.resolve("data/carrier-catalogs/combined-carrier-candidates.json");
const OUT_JSON = path.resolve("data/carrier-catalogs/carrier-implementation-backlog.json");
const OUT_CSV = path.resolve("data/carrier-catalogs/carrier-implementation-backlog.csv");
const CONFIG_DIR = path.resolve("src/carriers/configs");
const CARRIER_DIR = path.resolve("src/carriers");

const DEDICATED = "dedicated_scraper";
const CONFIG = "config_adapter";

const TARGETS = [
  {
    tier: "P0",
    name: "Amazon Logistics",
    aliases: ["amazon logistics", "amazon"],
    countries: ["US", "GB", "DE", "FR", "IT", "ES", "JP"],
    mode: DEDICATED,
    score: 100,
    notes:
      "High-volume marketplace delivery gap; likely requires browser session handling and regional tracking-page variants.",
  },
  {
    tier: "P0",
    name: "DHL eCommerce",
    aliases: ["dhl ecommerce", "dhl global mail", "dhl ecommerce asia", "dhlparcel uk"],
    countries: ["US", "DE", "GB", "HK", "SG"],
    mode: DEDICATED,
    score: 98,
    futureApiIfEverApplicable: true,
    notes:
      "Complements existing DHL/DHL Express coverage; major cross-border ecommerce network with multiple catalog identities.",
  },
  {
    tier: "P0",
    name: "PostNL",
    aliases: ["postnl", "postnl domestic", "postnl international", "postnl international mail"],
    countries: ["NL"],
    mode: CONFIG,
    score: 96,
    notes:
      "Large EU postal/export gap and common China-to-EU handoff carrier; likely adapter-friendly if public HTML remains stable.",
  },
  {
    tier: "P0",
    name: "Correos de Espana",
    aliases: ["correos de espana", "correos de españa", "spain correos es"],
    sourceIds: {
      aftershipSlugs: ["spain-correos-es", "correosexpress"],
      seventeenTrackKeys: ["100048"],
    },
    countries: ["ES"],
    mode: CONFIG,
    score: 94,
    notes: "National postal carrier for Spain; important EU parity gap.",
  },
  {
    tier: "P0",
    name: "Poste Italiane",
    aliases: ["poste italiane"],
    countries: ["IT"],
    mode: CONFIG,
    score: 93,
    notes: "National postal carrier for Italy; broad domestic and international handoff volume.",
  },
  {
    tier: "P0",
    name: "Bpost",
    aliases: ["bpost", "bpost international"],
    countries: ["BE"],
    mode: CONFIG,
    score: 92,
    notes: "Belgium postal and international ecommerce carrier; common EU cross-border gap.",
  },
  {
    tier: "P0",
    name: "Swiss Post",
    aliases: ["swiss post"],
    countries: ["CH"],
    mode: CONFIG,
    score: 91,
    notes: "National postal carrier for Switzerland; high-value EU-adjacent market.",
  },
  {
    tier: "P0",
    name: "Austrian Post",
    aliases: ["austrian post", "austrian post express", "austrian post registered"],
    countries: ["AT"],
    mode: CONFIG,
    score: 90,
    notes: "National postal carrier for Austria; fills DACH coverage gap after Deutsche Post.",
  },
  {
    tier: "P1",
    name: "Purolator",
    aliases: ["purolator", "purolator freight", "purolator international"],
    countries: ["CA", "US"],
    mode: CONFIG,
    score: 89,
    notes: "Major Canadian parcel carrier; complements existing Canada Post support.",
  },
  {
    tier: "P1",
    name: "Intelcom",
    aliases: ["intelcom", "intelcom ca"],
    countries: ["CA"],
    mode: DEDICATED,
    score: 88,
    notes: "High Canadian ecommerce last-mile volume; likely dynamic tracking site.",
  },
  {
    tier: "P1",
    name: "TForce",
    aliases: ["tforce final mile", "tforce freight", "tforce freight ups freight"],
    countries: ["US", "CA"],
    mode: CONFIG,
    score: 87,
    notes: "North American parcel/freight gap; include final-mile and freight catalog variants.",
  },
  {
    tier: "P1",
    name: "Blue Dart",
    aliases: ["blue dart", "blue dart express"],
    countries: ["IN"],
    mode: DEDICATED,
    score: 86,
    futureApiIfEverApplicable: true,
    notes: "Major Indian express carrier and DHL affiliate; high competitor-parity value.",
  },
  {
    tier: "P1",
    name: "Delhivery",
    aliases: ["delhivery", "delhivery webhook"],
    countries: ["IN"],
    mode: DEDICATED,
    score: 85,
    futureApiIfEverApplicable: true,
    notes: "Major India ecommerce logistics provider; expect dynamic app/API-backed tracking.",
  },
  {
    tier: "P1",
    name: "Ekart",
    aliases: ["ekart"],
    countries: ["IN"],
    mode: DEDICATED,
    score: 84,
    notes: "Flipkart logistics network; important India marketplace coverage gap.",
  },
  {
    tier: "P1",
    name: "XpressBees",
    aliases: ["xpressbees"],
    countries: ["IN"],
    mode: DEDICATED,
    score: 83,
    futureApiIfEverApplicable: true,
    notes: "Large India ecommerce carrier; likely needs dedicated browser/API-flow scraper.",
  },
  {
    tier: "P1",
    name: "Pos Malaysia",
    aliases: ["pos malaysia"],
    countries: ["MY"],
    mode: CONFIG,
    score: 82,
    notes: "National postal carrier for Malaysia; fills Southeast Asia postal gap.",
  },
  {
    tier: "P1",
    name: "Ninja Van",
    aliases: ["ninja van", "ninja van singapore", "ninja van malaysia", "ninja van indonesia", "ninja van thailand"],
    countries: ["SG", "MY", "ID", "TH", "PH", "VN"],
    mode: DEDICATED,
    score: 81,
    futureApiIfEverApplicable: true,
    notes: "Major Southeast Asia ecommerce last-mile network with regional catalog variants.",
  },
  {
    tier: "P1",
    name: "J&T Express",
    aliases: ["j t express", "j&t express", "jtexpress"],
    countries: ["ID", "MY", "PH", "TH", "VN", "CN", "BR", "MX", "AE"],
    mode: DEDICATED,
    score: 80,
    futureApiIfEverApplicable: true,
    notes: "Fast-growing global ecommerce carrier; prioritize ID/MY/PH/TH before smaller country variants.",
  },
  {
    tier: "P1",
    name: "Flash Express",
    aliases: ["flash express", "flashexpress", "flash express th", "flash express ph"],
    countries: ["TH", "PH", "MY", "LA"],
    mode: DEDICATED,
    score: 79,
    notes: "High-volume Southeast Asia parcel network; likely dynamic regional tracking flows.",
  },
  {
    tier: "P1",
    name: "Kerry Express",
    aliases: ["kerry express", "kerry express th", "kerry express hk", "kerry express vietnam"],
    countries: ["TH", "HK", "TW", "VN"],
    mode: DEDICATED,
    score: 78,
    notes: "Major Southeast Asia and Hong Kong parcel carrier; regional implementations may differ.",
  },
  {
    tier: "P1",
    name: "Pos Indonesia",
    aliases: ["pos indonesia", "pos indonesia domestic"],
    countries: ["ID"],
    mode: CONFIG,
    score: 77,
    notes: "National postal carrier for Indonesia; important SEA postal coverage gap.",
  },
  {
    tier: "P1",
    name: "JNE Express",
    aliases: ["jne", "jne api", "jne express"],
    countries: ["ID"],
    mode: DEDICATED,
    score: 76,
    futureApiIfEverApplicable: true,
    notes: "Large Indonesia ecommerce carrier; likely API-backed web tracking.",
  },
  {
    tier: "P1",
    name: "ZTO Express",
    aliases: ["zto express", "zto express china", "zto express global", "zto domestic"],
    countries: ["CN"],
    mode: DEDICATED,
    score: 75,
    futureApiIfEverApplicable: true,
    notes: "Top China parcel carrier; high export/ecommerce relevance beyond existing China Post/SF/YunExpress/4PX.",
  },
  {
    tier: "P1",
    name: "YTO Express",
    aliases: ["yto express", "yto"],
    countries: ["CN"],
    mode: DEDICATED,
    score: 74,
    notes: "Top China parcel carrier; competitor parity gap for domestic/export Chinese marketplaces.",
  },
  {
    tier: "P1",
    name: "STO Express",
    aliases: ["sto express", "sto"],
    sourceIds: {
      aftershipSlugs: ["sto"],
      seventeenTrackKeys: ["190324"],
    },
    countries: ["CN"],
    mode: DEDICATED,
    score: 73,
    notes: "Top China parcel carrier; validate catalog matching because short name can collide with unrelated carriers.",
  },
  {
    tier: "P1",
    name: "JD Logistics",
    aliases: ["jd logistics"],
    countries: ["CN"],
    mode: DEDICATED,
    score: 72,
    futureApiIfEverApplicable: true,
    notes: "Major China marketplace logistics network; likely requires dedicated dynamic scraper.",
  },
  {
    tier: "P2",
    name: "Chronopost",
    aliases: ["chronopost", "chronopost france"],
    countries: ["FR"],
    mode: CONFIG,
    score: 71,
    notes: "Major French express carrier; complements existing La Poste.",
  },
  {
    tier: "P2",
    name: "Colissimo",
    aliases: ["colissimo", "la poste colissimo"],
    countries: ["FR"],
    mode: CONFIG,
    score: 70,
    notes: "Important French parcel product; may share infrastructure with La Poste but should be tracked explicitly.",
  },
  {
    tier: "P2",
    name: "Mondial Relay",
    aliases: ["mondial relay", "mondialrelay", "mondial relay france", "mondial relay spain"],
    countries: ["FR", "ES", "BE"],
    mode: CONFIG,
    score: 69,
    notes: "Large European out-of-home parcel network; good adapter candidate if public tracking HTML is stable.",
  },
  {
    tier: "P2",
    name: "Colis Prive",
    aliases: ["colis prive", "colis privé"],
    countries: ["FR"],
    mode: CONFIG,
    score: 68,
    notes: "French ecommerce last-mile carrier; regional parity gap.",
  },
  {
    tier: "P2",
    name: "Parcelforce",
    aliases: ["parcelforce", "parcel force"],
    countries: ["GB"],
    mode: CONFIG,
    score: 67,
    notes: "UK parcel carrier adjacent to Royal Mail; important for heavier parcels.",
  },
  {
    tier: "P2",
    name: "Hermesworld",
    aliases: ["hermesworld", "hermes"],
    countries: ["DE", "GB"],
    mode: CONFIG,
    score: 66,
    notes: "Legacy Hermes identity still appears in catalogs and labels; map carefully against existing Evri coverage.",
  },
  {
    tier: "P2",
    name: "InPost",
    aliases: ["inpost", "inpost uk", "inpost pl", "inpost it", "inpost es"],
    countries: ["PL", "GB", "IT", "ES", "PT"],
    mode: CONFIG,
    score: 65,
    notes: "Large parcel-locker network across Europe; start with PL/UK/IT variants.",
  },
  {
    tier: "P2",
    name: "Packeta",
    aliases: ["packeta"],
    countries: ["CZ", "SK", "HU", "PL"],
    mode: CONFIG,
    score: 64,
    notes: "Central/Eastern Europe ecommerce pickup network; likely single adapter can cover several countries.",
  },
  {
    tier: "P2",
    name: "Poczta Polska",
    aliases: ["poczta polska"],
    countries: ["PL"],
    mode: CONFIG,
    score: 63,
    notes: "National postal carrier for Poland.",
  },
  {
    tier: "P2",
    name: "BRT Bartolini",
    aliases: ["brt", "brt bartolini", "brt it"],
    countries: ["IT"],
    mode: CONFIG,
    score: 62,
    notes: "Major Italian parcel carrier; include DPD/BRT catalog variants in dedupe review.",
  },
  {
    tier: "P2",
    name: "SEUR",
    aliases: ["seur", "spanish seur", "international seur", "portugal seur"],
    countries: ["ES", "PT"],
    mode: CONFIG,
    score: 61,
    notes: "Major Iberian parcel carrier and DPDgroup member.",
  },
  {
    tier: "P2",
    name: "MRW",
    aliases: ["mrw", "mrw spain"],
    countries: ["ES"],
    mode: CONFIG,
    score: 60,
    notes: "Major Spanish courier; complements Correos/SEUR coverage.",
  },
  {
    tier: "P2",
    name: "Correios Brazil",
    aliases: ["correios brazil", "correios brasil"],
    countries: ["BR"],
    mode: CONFIG,
    score: 59,
    notes: "National postal carrier for Brazil; major LATAM coverage gap.",
  },
  {
    tier: "P2",
    name: "MailAmericas",
    aliases: ["mailamericas"],
    countries: ["MU", "US", "BR", "MX", "CL"],
    mode: CONFIG,
    score: 58,
    notes: "Cross-border ecommerce consolidator frequently seen in LATAM flows.",
  },
  {
    tier: "P2",
    name: "Landmark Global",
    aliases: ["landmark global"],
    countries: ["BE", "US", "CA", "GB"],
    mode: CONFIG,
    score: 57,
    notes: "Cross-border ecommerce carrier; useful for North America/EU handoffs.",
  },
  {
    tier: "P2",
    name: "Asendia",
    aliases: ["asendia", "asendia global", "asendia de", "asendia hk", "asendia uk"],
    countries: ["FR", "DE", "GB", "HK", "US"],
    mode: CONFIG,
    score: 56,
    notes: "Major international mail/ecommerce consolidator; multiple regional catalog rows.",
  },
  {
    tier: "P2",
    name: "Saudi Post",
    aliases: ["saudi post", "spl"],
    countries: ["SA"],
    mode: CONFIG,
    score: 55,
    notes: "National postal carrier for Saudi Arabia; MENA coverage gap.",
  },
  {
    tier: "P2",
    name: "SMSA Express",
    aliases: ["smsa", "smsa express"],
    countries: ["SA"],
    mode: CONFIG,
    score: 54,
    notes: "Major Saudi courier; good follow-up after Saudi Post.",
  },
  {
    tier: "P2",
    name: "Qatar Post",
    aliases: ["qatar post", "q post"],
    countries: ["QA"],
    mode: CONFIG,
    score: 53,
    notes: "National postal carrier for Qatar.",
  },
  {
    tier: "P3",
    name: "Gati",
    aliases: ["gati", "gati kwe"],
    countries: ["IN"],
    mode: CONFIG,
    score: 52,
    notes: "Indian express/freight carrier; lower priority than ecommerce-first India carriers.",
  },
  {
    tier: "P3",
    name: "An Post",
    aliases: ["an post"],
    countries: ["IE"],
    mode: CONFIG,
    score: 51,
    notes: "National postal carrier for Ireland.",
  },
  {
    tier: "P3",
    name: "PostNord",
    aliases: ["postnord", "postnord denmark", "postnord sweden"],
    countries: ["SE", "DK", "NO", "FI"],
    mode: CONFIG,
    score: 50,
    notes: "Nordic postal/logistics gap; implement if present in catalog and public tracking is stable.",
  },
  {
    tier: "P3",
    name: "Bring",
    aliases: ["bring"],
    sourceIds: {
      aftershipSlugs: ["bring", "posten-norge"],
      seventeenTrackKeys: ["100423"],
    },
    countries: ["NO", "SE", "DK"],
    mode: CONFIG,
    score: 49,
    notes: "Nordic parcel carrier; useful after PostNord.",
  },
  {
    tier: "P3",
    name: "Omniva",
    aliases: ["omniva", "estonian post"],
    countries: ["EE", "LV", "LT"],
    mode: CONFIG,
    score: 48,
    notes: "Baltic postal/logistics carrier.",
  },
  {
    tier: "P3",
    name: "Nova Poshta",
    aliases: ["nova poshta", "nova post"],
    countries: ["UA"],
    mode: CONFIG,
    score: 47,
    notes: "Major Ukrainian parcel carrier.",
  },
];

const EXTRA_IMPLEMENTED = ["ups", "usps", "fedex", "dhl", "dhl-express"];

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function slugify(value) {
  return normalize(value).replaceAll(" ", "-");
}

function csvEscape(value) {
  const stringValue = value == null ? "" : String(value);
  if (!/[",\n\r]/.test(stringValue)) return stringValue;
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function toCsv(rows) {
  const headers = [
    "rank",
    "priority_tier",
    "carrier_name",
    "canonical_slug",
    "suggested_implementation_mode",
    "future_api_if_ever_applicable",
    "score",
    "countries",
    "aftership_slugs",
    "seventeen_track_keys",
    "catalog_source_count",
    "coverage_gap",
    "notes",
  ];

  return [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((header) => {
          const value = row[header];
          return csvEscape(Array.isArray(value) ? value.join("|") : value);
        })
        .join(","),
    ),
    "",
  ].join("\n");
}

async function listImplementedCarrierIds() {
  const ids = new Set(EXTRA_IMPLEMENTED);

  try {
    const configFiles = await readdir(CONFIG_DIR);
    for (const file of configFiles) {
      if (file.endsWith(".json")) ids.add(file.slice(0, -".json".length));
    }
  } catch {
    // Planning output can still be generated before runtime configs exist.
  }

  try {
    const carrierFiles = await readdir(CARRIER_DIR);
    for (const file of carrierFiles) {
      if (file.endsWith(".ts")) ids.add(file.slice(0, -".ts".length));
    }
  } catch {
    // Same fallback as config discovery.
  }

  return ids;
}

function matchesTarget(carrier, target) {
  if (target.sourceIds) {
    return (
      target.sourceIds.aftershipSlugs?.includes(carrier.aftership_slug) ||
      target.sourceIds.seventeenTrackKeys?.includes(carrier.seventeen_track_key)
    );
  }

  const searchable = [
    carrier.normalized_name,
    normalize(carrier.display_name),
    normalize(carrier.aftership_slug),
    normalize(carrier.aftership_slug).replace(/\bapi\b|\bwebhook\b/g, "").trim(),
  ].filter(Boolean);

  return target.aliases.some((alias) => {
    const normalizedAlias = normalize(alias);
    return searchable.some(
      (value) =>
        value === normalizedAlias ||
        (normalizedAlias.length > 4 && value.startsWith(`${normalizedAlias} `)),
    );
  });
}

function sourceRecordsForTarget(carriers, target) {
  const records = carriers
    .filter((carrier) => matchesTarget(carrier, target))
    .map((carrier) => ({
      display_name: carrier.display_name,
      aftership_slug: carrier.aftership_slug,
      seventeen_track_key: carrier.seventeen_track_key,
      country_iso: carrier.country_iso,
      url: carrier.url,
      sources: carrier.sources,
    }));

  const seen = new Set();
  return records.filter((record) => {
    const key = [
      record.display_name,
      record.aftership_slug,
      record.seventeen_track_key,
      record.country_iso,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function implementedSlugMatches(target, implementedIds) {
  const slugs = new Set([
    slugify(target.name),
    ...target.aliases.map(slugify),
  ]);

  return [...slugs].some((slug) => implementedIds.has(slug));
}

async function main() {
  const catalog = JSON.parse(await readFile(CATALOG_PATH, "utf8"));
  const carriers = catalog.carriers ?? [];
  const implementedIds = await listImplementedCarrierIds();

  const rows = TARGETS.map((target) => {
    const sourceRecords = sourceRecordsForTarget(carriers, target);
    const aftershipSlugs = [
      ...new Set(sourceRecords.map((record) => record.aftership_slug).filter(Boolean)),
    ].sort();
    const seventeenTrackKeys = [
      ...new Set(sourceRecords.map((record) => record.seventeen_track_key).filter(Boolean)),
    ].sort();
    const catalogCountries = [
      ...new Set(sourceRecords.map((record) => record.country_iso).filter(Boolean)),
    ].sort();
    const countries = [...new Set([...target.countries, ...catalogCountries])].sort();
    const implemented = implementedSlugMatches(target, implementedIds);

    return {
      priority_tier: target.tier,
      carrier_name: target.name,
      canonical_slug: slugify(target.name),
      suggested_implementation_mode: target.mode,
      future_api_if_ever_applicable: Boolean(target.futureApiIfEverApplicable),
      score: target.score,
      countries,
      aftership_slugs: aftershipSlugs,
      seventeen_track_keys: seventeenTrackKeys,
      source_records: sourceRecords,
      catalog_source_count: sourceRecords.length,
      coverage_gap: !implemented,
      implemented_id_collision: implemented,
      notes: target.notes,
    };
  })
    .filter((row) => row.coverage_gap)
    .sort((a, b) => b.score - a.score || a.carrier_name.localeCompare(b.carrier_name))
    .map((row, index) => ({ rank: index + 1, ...row }));

  const output = {
    generated_at: new Date().toISOString(),
    source_catalog: path.relative(process.cwd(), CATALOG_PATH),
    methodology:
      "Prioritized manually by global parcel/ecommerce importance, competitor-parity value, and whether the carrier is absent from current dedicated/config scraper IDs. Source ids/slugs are resolved from the combined AfterShip + 17TRACK candidate catalog.",
    current_implemented_ids: [...implementedIds].sort(),
    count: rows.length,
    carriers: rows,
  };

  await writeFile(OUT_JSON, `${JSON.stringify(output, null, 2)}\n`);
  await writeFile(OUT_CSV, toCsv(rows));

  console.log(`Wrote ${path.relative(process.cwd(), OUT_JSON)} (${rows.length} rows)`);
  console.log(`Wrote ${path.relative(process.cwd(), OUT_CSV)} (${rows.length} rows)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
