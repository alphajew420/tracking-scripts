import { withPage, closeBrowser } from "./src/browser.ts";

const NUM = process.argv[2] ?? "746965179400";
const URL = `https://www.fedex.com/fedextrack/?trknbr=${NUM}`;

await withPage(async (page) => {
  const xhrs: { url: string; status: number; ct: string; method: string }[] = [];
  page.on("request", (req) => {
    if (req.resourceType() === "xhr" || req.resourceType() === "fetch") {
      // noop, we capture on response
    }
  });
  page.on("response", (r) => {
    const ct = r.headers()["content-type"] || "";
    xhrs.push({ url: r.url(), status: r.status(), ct, method: r.request().method() });
  });

  console.log(`navigating ${URL}`);
  await page.goto(URL, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(10000);
  console.log(`final: ${page.url()}`);
  console.log(`title: ${await page.title()}`);

  console.log(`\n=== JSON responses from fedex.com (likely API calls) ===`);
  for (const r of xhrs) {
    if (!r.url.includes("fedex.com")) continue;
    if (!r.ct.includes("json") && !r.url.match(/\/(track|api)/i)) continue;
    if (r.url.match(/\.(js|css|woff2?|png|jpg|svg)(\?|$)/)) continue;
    console.log(`  ${r.method} ${r.status} ${r.ct.slice(0, 30).padEnd(30)} ${r.url.slice(0, 120)}`);
  }
});
await closeBrowser();
