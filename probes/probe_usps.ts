import { withPage, closeBrowser } from "./src/browser.ts";
import { writeFile } from "node:fs/promises";

const NUM = process.argv[2] ?? "9400111899223816042167";

await withPage(async (page) => {
  const responses: { url: string; status: number; ct: string }[] = [];
  page.on("response", (r) =>
    responses.push({ url: r.url(), status: r.status(), ct: r.headers()["content-type"] || "" }),
  );

  const URL = `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${NUM}`;
  console.log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(8000);

  console.log(`final URL: ${page.url()}`);
  console.log(`title: ${await page.title()}`);

  const html = await page.content();
  await writeFile("usps-page.html", html);
  console.log(`saved HTML (${html.length} bytes)`);

  await page.screenshot({ path: "usps-page.png", fullPage: false });

  // Look for candidate event selectors
  const candidates = await page.evaluate(() => {
    const tests = [
      "#trackingHistory_1",
      "[id^='trackingHistory']",
      ".tracking-history",
      "[class*='tracking-history']",
      "[class*='step-details']",
      "[data-testid*='tracking']",
    ];
    const out: Record<string, number> = {};
    for (const sel of tests) out[sel] = document.querySelectorAll(sel).length;
    return out;
  });
  console.log("DOM candidates:", candidates);

  console.log(`\n=== responses with json content-type ===`);
  for (const r of responses) {
    if (!r.ct.includes("json")) continue;
    console.log(`  ${r.status} ${r.ct.slice(0, 30)} ${r.url}`);
  }

  console.log(`\n=== any tools.usps.com XHRs ===`);
  for (const r of responses) {
    if (!r.url.includes("usps.com")) continue;
    if (r.url.match(/\.(png|jpg|svg|woff2?|css|js)(\?|$)/)) continue;
    console.log(`  ${r.status} ${r.ct.slice(0, 30).padEnd(30)} ${r.url.slice(0, 120)}`);
  }
});

await closeBrowser();
