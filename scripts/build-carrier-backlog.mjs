import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const CATALOG_DIR = path.resolve("data/carrier-catalogs");
const combinedPath = path.join(CATALOG_DIR, "combined-carrier-candidates.json");
const CONFIG_DIR = path.resolve("src/carriers/configs");
const HAND_CODED_IDS = new Set(["dhl", "dhl-express", "fedex", "ups", "usps"]);

const priorityRules = [
  {
    tier: "P0",
    mode: "dedicated_scraper",
    names: [
      "UPS",
      "FedEx",
      "USPS",
      "DHL",
      "DHL Express",
      "Royal Mail",
      "Canada Post",
      "Australia Post",
      "La Poste",
      "Deutsche Post",
      "Japan Post",
      "China Post",
      "EMS",
      "Aramex",
      "TNT",
      "GLS",
      "DPD UK",
      "Evri",
      "OnTrac",
      "LaserShip",
      "YunExpress",
      "4PX",
      "SF Express",
    ],
  },
  {
    tier: "P1",
    mode: "config_adapter",
    names: [
      "Cainiao",
      "AliExpress",
      "Yanwen",
      "Sunyou",
      "WishPost",
      "DHL eCommerce",
      "DPD",
      "Hermes",
      "Yodel",
      "Pitney Bowes",
      "Asendia",
      "Landmark Global",
      "OSM Worldwide",
      "Blue Dart",
      "Delhivery",
      "Ekart",
      "J&T Express",
      "Ninja Van",
      "JNE",
      "ZTO Express",
      "YTO Express",
      "STO Express",
      "Yunda Express",
      "ZJS Express",
      "Correos",
      "PostNL",
      "Bpost",
      "Swiss Post",
      "Poste Italiane",
      "Correios Brazil",
      "Chronopost",
      "Colissimo",
      "Purolator",
      "Canpar",
      "Loomis Express",
    ],
  },
  {
    tier: "P2",
    mode: "config_adapter",
    names: [
      "CJ Logistics",
      "Lotte Global Logistics",
      "Korea Post",
      "Sagawa",
      "Yamato",
      "Hongkong Post",
      "Singapore Post",
      "Taiwan Post",
      "Thailand Post",
      "Vietnam Post",
      "Indonesia Post",
      "Malaysia Post",
      "Philippines Post",
      "India Post",
      "DTDC",
      "XpressBees",
      "Shadowfax",
      "Gati",
      "GLS Spain",
      "Mondial Relay",
      "InPost",
      "Packeta",
      "Nova Poshta",
      "DHL Parcel",
      "SEUR",
      "MRW",
      "Poczta Polska",
      "PostNord",
      "Bring",
      "Austrian Post",
    ],
  },
];

function normalizeName(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function slugify(name) {
  return normalizeName(name).replaceAll(" ", "-");
}

function buildRuleMap() {
  const map = new Map();
  for (const rule of priorityRules) {
    for (const name of rule.names) {
      map.set(normalizeName(name), rule);
    }
  }
  return map;
}

function implementationStatus(carrier) {
  const likelyIds = [
    carrier.aftership_slug,
    carrier.normalized_name?.replaceAll(" ", "-"),
    slugify(carrier.display_name),
  ].filter(Boolean);

  return likelyIds.some((id) => registeredCarrierIds.has(id))
    ? "module_scaffolded"
    : "candidate";
}

function defaultMode(carrier) {
  if (carrier.sources.includes("aftership") && carrier.sources.includes("17track")) {
    return "config_adapter";
  }
  if (carrier.country_iso === "CN" || carrier.display_name.match(/post|express|logistics|courier/i)) {
    return "config_adapter";
  }
  return "research_required";
}

function priorityFor(carrier, ruleMap) {
  const direct = ruleMap.get(carrier.normalized_name);
  if (direct) return direct;

  if (carrier.sources.includes("aftership") && carrier.sources.includes("17track")) {
    return { tier: "P3", mode: defaultMode(carrier) };
  }

  if (carrier.aftership_slug || carrier.seventeen_track_key) {
    return { tier: "P4", mode: defaultMode(carrier) };
  }

  return { tier: "P5", mode: "research_required" };
}

function notesFor(carrier, status) {
  if (status === "module_scaffolded") return "Already present in Trackified registry; needs fixture/live verification before verified.";
  if (carrier.sources.includes("aftership") && carrier.sources.includes("17track")) return "Present in both competitor catalogs; prioritize metadata verification and public tracking surface research.";
  if (carrier.aftership_slug) return "Present in AfterShip catalog; research public tracking surface and tracking-number formats.";
  return "Present in 17TRACK catalog; research public tracking surface and tracking-number formats.";
}

function csvEscape(value) {
  const stringValue = value == null ? "" : String(value);
  if (!/[",\n\r]/.test(stringValue)) return stringValue;
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function toCsv(rows) {
  const headers = [
    "priority",
    "status",
    "suggested_mode",
    "display_name",
    "normalized_name",
    "aftership_slug",
    "seventeen_track_key",
    "country_iso",
    "url",
    "notes",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
    "",
  ].join("\n");
}

async function listRegisteredIds() {
  const configFiles = await readdir(CONFIG_DIR);
  return new Set([
    ...HAND_CODED_IDS,
    ...configFiles
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length)),
  ]);
}

const registeredCarrierIds = await listRegisteredIds();
const combined = JSON.parse(await readFile(combinedPath, "utf8"));
const ruleMap = buildRuleMap();

const backlog = combined.carriers.map((carrier) => {
  const priority = priorityFor(carrier, ruleMap);
  const status = implementationStatus(carrier);
  return {
    priority: priority.tier,
    status,
    suggested_mode: priority.mode,
    display_name: carrier.display_name,
    normalized_name: carrier.normalized_name,
    aftership_slug: carrier.aftership_slug,
    seventeen_track_key: carrier.seventeen_track_key,
    country_iso: carrier.country_iso,
    url: carrier.url,
    sources: carrier.sources,
    notes: notesFor(carrier, status),
  };
});

const priorityOrder = new Map(["P0", "P1", "P2", "P3", "P4", "P5"].map((tier, index) => [tier, index]));
const statusOrder = new Map([
  ["candidate", 0],
  ["planned", 1],
  ["module_scaffolded", 2],
  ["fixture_needed", 3],
  ["verified", 4],
  ["blocked", 5],
  ["deprecated", 6],
]);

backlog.sort((a, b) => {
  return (
    (priorityOrder.get(a.priority) ?? 99) - (priorityOrder.get(b.priority) ?? 99) ||
    (statusOrder.get(a.status) ?? 99) - (statusOrder.get(b.status) ?? 99) ||
    a.display_name.localeCompare(b.display_name)
  );
});

const summary = backlog.reduce((acc, row) => {
  acc.by_priority[row.priority] = (acc.by_priority[row.priority] ?? 0) + 1;
  acc.by_status[row.status] = (acc.by_status[row.status] ?? 0) + 1;
  return acc;
}, { by_priority: {}, by_status: {} });

await writeFile(
  path.join(CATALOG_DIR, "all-carrier-backlog.json"),
  `${JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      source_file: "combined-carrier-candidates.json",
      count: backlog.length,
      ...summary,
      carriers: backlog,
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  path.join(CATALOG_DIR, "all-carrier-backlog.csv"),
  toCsv(backlog),
);

console.log(`All-carrier backlog rows: ${backlog.length}`);
console.log(JSON.stringify(summary, null, 2));
